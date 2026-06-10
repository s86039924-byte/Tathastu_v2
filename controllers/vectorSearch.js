const { readFile } = require('node:fs/promises');
const path = require('node:path');

const VECTOR_STORE = {
  tathastuIndexesDir: path.join(__dirname, '..', 'openai_subject_index'),
  subjects: ['physics', 'chemistry', 'maths', 'biology'],
  topK: 10,
  finalTopN: 15,
  rrfK: 60,
};

const SUBFOLDER_SUFFIX = '_tagging_module';

let _indexes = null;

const parseNpy = (buf) => {
  if (buf[0] !== 0x93 || buf.subarray(1, 6).toString('ascii') !== 'NUMPY') {
    throw new Error('Not a NumPy .npy file (magic bytes mismatch)');
  }

  const major = buf[6];

  if (major !== 1 && major !== 2) {
    throw new Error(`Unsupported .npy major version: ${major}`);
  }

  const headerLen = major === 1 ? buf.readUInt16LE(8) : buf.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = buf.subarray(headerStart, headerStart + headerLen).toString('ascii');

  const dtypeMatch = header.match(/'descr':\s*'([^']+)'/);
  const fortranMatch = header.match(/'fortran_order':\s*(True|False)/);
  const shapeMatch = header.match(/'shape':\s*\(([^)]*)\)/);

  if (!dtypeMatch || !fortranMatch || !shapeMatch) {
    throw new Error(`Could not parse .npy header: ${header}`);
  }

  const dtype = dtypeMatch[1];

  if (dtype !== '<f4') {
    throw new Error(`Unsupported .npy dtype: ${dtype} (expected '<f4')`);
  }

  if (fortranMatch[1] === 'True') {
    throw new Error('Unsupported .npy: fortran_order=True');
  }

  const dims = shapeMatch[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseInt(s, 10));

  if (dims.length !== 2) {
    throw new Error(`Unsupported .npy shape (expected 2-D): (${shapeMatch[1]})`);
  }

  const rows = dims[0];
  const dim = dims[1];

  const dataStart = headerStart + headerLen;
  const expectedBytes = rows * dim * 4;

  if (buf.length - dataStart !== expectedBytes) {
    throw new Error(
      `.npy data size mismatch: expected ${expectedBytes} bytes, got ${buf.length - dataStart}`,
    );
  }

  const ab = new ArrayBuffer(expectedBytes);
  Buffer.from(ab).set(buf.subarray(dataStart, dataStart + expectedBytes));

  return {
    vectors: new Float32Array(ab),
    rows,
    dim,
  };
};

const normalizeRows = (vectors, rows, dim) => {
  for (let r = 0; r < rows; r++) {
    let norm = 0;
    const offset = r * dim;

    for (let i = 0; i < dim; i++) {
      const v = vectors[offset + i];
      norm += v * v;
    }

    norm = Math.sqrt(norm);

    if (norm > 0) {
      for (let i = 0; i < dim; i++) {
        vectors[offset + i] /= norm;
      }
    }
  }
};

const loadSubject = async (indexesDir, subject) => {
  const subfolder = path.join(indexesDir, `${subject}${SUBFOLDER_SUFFIX}`);
  const chunkPath = path.join(subfolder, `${subject}_chunk_data.json`);
  const vectorPath = path.join(subfolder, `${subject}_embedding_vectors.npy`);

  let chunkBuf;
  let vectorBuf;

  try {
    [chunkBuf, vectorBuf] = await Promise.all([
      readFile(chunkPath),
      readFile(vectorPath),
    ]);
  } catch (err) {
    console.warn(`[vectorSearch] skipping ${subject} — file(s) missing`, err);
    return null;
  }

  const chunks = JSON.parse(chunkBuf.toString('utf-8'));
  const { vectors, rows, dim } = parseNpy(vectorBuf);

  if (chunks.length !== rows) {
    console.warn(
      `[vectorSearch] skipping ${subject} — chunk/vector count mismatch`,
      {
        subject,
        chunks: chunks.length,
        rows,
      },
    );
    return null;
  }

  normalizeRows(vectors, rows, dim);

  console.log(`[vectorSearch] loaded ${subject}`, {
    subject,
    count: rows,
    dim,
  });

  return {
    chunks,
    vectors,
    count: rows,
    dim,
  };
};

const loadIndexes = async (indexesDir = VECTOR_STORE.tathastuIndexesDir) => {
  if (!indexesDir) {
    throw new Error('TATHASTU_INDEXES_DIR is not configured in environment variables.');
  }

  const out = {};

  for (const subj of VECTOR_STORE.subjects) {
    const idx = await loadSubject(indexesDir, subj);

    if (idx) {
      out[subj] = idx;
    }
  }

  console.log('[vectorSearch] indexes loaded', {
    subjects: Object.keys(out),
    total: Object.keys(out).length,
  });

  return out;
};

const getSubjectIndexes = async () => {
  if (_indexes === null) {
    _indexes = await loadIndexes();
  }

  return _indexes;
};

const searchTopK = (index, queryVector, k) => {
  if (queryVector.length !== index.dim) {
    throw new Error(`query dim ${queryVector.length} != index dim ${index.dim}`);
  }

  const { vectors, count, dim } = index;

  const heap = [];
  const k_ = Math.min(k, count);

  for (let r = 0; r < count; r++) {
    const offset = r * dim;
    let score = 0;

    for (let i = 0; i < dim; i++) {
      score += vectors[offset + i] * queryVector[i];
    }

    if (heap.length < k_) {
      heap.push({ row: r, score });

      if (heap.length === k_) {
        heap.sort((a, b) => a.score - b.score);
      }
    } else if (score > heap[0].score) {
      heap[0] = { row: r, score };
      heap.sort((a, b) => a.score - b.score);
    }
  }

  return heap.sort((a, b) => b.score - a.score);
};

const searchTopKBySubject = async (
  subject,
  queryVector,
  k = VECTOR_STORE.topK,
) => {
  const indexes = await getSubjectIndexes();
  const idx = indexes[subject];

  if (!idx) return [];

  return searchTopK(idx, queryVector, k).map((h) => ({
    docId: `${subject}||${h.row}`,
    subject,
    row: h.row,
    score: h.score,
    chunk: idx.chunks[h.row],
  }));
};

const searchTopKAcrossSubjects = async (
  queryVector,
  k = VECTOR_STORE.topK,
) => {
  const indexes = await getSubjectIndexes();
  const combined = [];

  for (const [subject, idx] of Object.entries(indexes)) {
    for (const h of searchTopK(idx, queryVector, k)) {
      combined.push({
        docId: `${subject}||${h.row}`,
        subject,
        row: h.row,
        score: h.score,
        chunk: idx.chunks[h.row],
      });
    }
  }

  return combined.sort((a, b) => b.score - a.score).slice(0, k);
};

const getChunk = async (docId) => {
  const [subject, rowStr] = docId.split('||');

  if (!subject || !rowStr) return null;

  const row = parseInt(rowStr, 10);

  if (Number.isNaN(row)) return null;

  const indexes = await getSubjectIndexes();
  const idx = indexes[subject];

  if (!idx) return null;

  return idx.chunks[row] ?? null;
};

module.exports = {
  loadIndexes,
  getSubjectIndexes,
  searchTopK,
  searchTopKBySubject,
  searchTopKAcrossSubjects,
  getChunk,
};