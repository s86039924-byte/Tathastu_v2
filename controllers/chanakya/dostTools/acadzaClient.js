const { randomUUID } = require('crypto');
const fetch = require('node-fetch');
const { AbortController } = require('abort-controller');

const ACADZA_BASE_URL =
  process.env.ACADZA_API_BASE_URL || process.env.ACADZA_BASE_URL || '';

const ACADZA_TIMEOUT_MS =
  Number(process.env.ACADZA_TIMEOUT_MS || 60000);

const ACADZA_MAX_RETRIES =
  Number(process.env.ACADZA_MAX_RETRIES || 2);

const ACADZA_RETRY_DELAY_MS =
  Number(process.env.ACADZA_RETRY_DELAY_MS || 1000);

const LINK_FIELD_MAP = {
  practiceTest: 'testLink',
  practiceAssignment: 'assignmentLink',
  formula: 'formulaLink',
  revision: 'revisionLink',
  clickingPower: 'clickingLink',
  pickingPower: 'pickingLink',
  speedRace: 'raceLink',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isFourXx = (status) => status >= 400 && status < 500;

const fetchWithTimeout = async (
  url,
  init,
  timeoutMs = ACADZA_TIMEOUT_MS,
) => {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(t);
  }
};

const createMockDost = (payload) => {
  const dostType = String(payload.bulkRequestType ?? payload['bulkRequestType'] ?? 'unknown');
  const mockId = randomUUID().slice(0, 8);

  return {
    success: true,
    dost_id: `mock_${dostType}_${mockId}`,
    link: `https://acadza.com/dost/mock_${mockId}`,
    error: null,
  };
};

const parseAcadzaSuccess = (dostType, data) => {
  if (dostType === 'concept') {
    const urlshort = data.urlshort ?? data['urlshort'] ?? {};
    const longurl = String(urlshort.longurl ?? urlshort['longurl'] ?? '');

    const fullUrl = longurl.startsWith('http')
      ? longurl
      : `https://acadza.com${longurl}`;

    const dostId = longurl
      ? longurl.split('/').pop() ?? 'unknown'
      : 'unknown';

    return {
      success: true,
      dost_id: dostId,
      link: fullUrl,
      error: null,
    };
  }

  const section = (data.data ?? data['data'] ?? {})[dostType];

  if (!section) {
    return {
      success: false,
      dost_id: null,
      link: null,
      error: `No data section for ${dostType} in response`,
    };
  }

  const linkField = LINK_FIELD_MAP[dostType] ?? 'link';
  const linkPath = String(section[linkField] ?? '');

  if (!linkPath) {
    return {
      success: false,
      dost_id: null,
      link: null,
      error: `No link found in response for ${dostType}`,
    };
  }

  const fullUrl = linkPath.startsWith('http')
    ? linkPath
    : `https://acadza.com${linkPath}`;

  const dostId = linkPath.split('/').pop() ?? 'unknown';

  return {
    success: true,
    dost_id: dostId,
    link: fullUrl,
    error: null,
  };
};

const createDost = async (payload, opts = {}) => {
  const apiUrl = opts.apiUrl || ACADZA_BASE_URL;
  const timeoutMs = opts.timeoutMs || ACADZA_TIMEOUT_MS;
  const maxRetries = opts.maxRetries || ACADZA_MAX_RETRIES;
  const retryDelayMs = opts.retryDelayMs || ACADZA_RETRY_DELAY_MS;

  const dostType = String(payload.bulkRequestType ?? payload['bulkRequestType'] ?? 'unknown');

  const mockMode = opts.mockMode ?? (process.env.ACADZA_MOCK_MODE === 'true');
  if (mockMode) {
    return createMockDost(payload);
  }

  if (!apiUrl) {
    return {
      success: false,
      dost_id: null,
      link: null,
      error: 'Acadza API URL not configured',
    };
  }

  const endpoint =
    dostType === 'concept'
      ? `${apiUrl}/shorturl/create`
      : `${apiUrl}/combined/create`;

  const requestPayload =
    dostType === 'concept'
      ? {
          shorturl: payload.shorturl ?? payload['shorturl'],
          longurl: payload.longurl ?? payload['longurl'],
          meta: payload.meta ?? payload['meta'],
        }
      : {
          requestList: [payload],
        };

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetchWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify(requestPayload),
        },
        timeoutMs,
      );

      let bodyText = '';
      let data = {};

      try {
        bodyText = await res.text();
        data = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        bodyText = '';
        data = {};
      }

      if (res.status === 200 || res.status === 201) {
        return parseAcadzaSuccess(dostType, data);
      }

      const errorMsg = `API returned status ${res.status}: ${bodyText.slice(0, 200)}`;

      if (isFourXx(res.status)) {
        return {
          success: false,
          dost_id: null,
          link: null,
          error: errorMsg,
        };
      }

      if (attempt < maxRetries - 1) {
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }

      return {
        success: false,
        dost_id: null,
        link: null,
        error: errorMsg,
      };
    } catch (err) {
      const isAbort = err.name === 'AbortError';

      const errorMsg = isAbort
        ? `Request timeout after ${timeoutMs}ms`
        : `Request failed: ${err.message ?? String(err)}`;

      if (attempt < maxRetries - 1) {
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }

      return {
        success: false,
        dost_id: null,
        link: null,
        error: errorMsg,
      };
    }
  }

  return {
    success: false,
    dost_id: null,
    link: null,
    error: 'Max retries exceeded',
  };
};

const acadzaLogin = async (username, password, opts = {}) => {
  const apiUrl = opts.apiUrl || ACADZA_BASE_URL;
  const timeoutMs = opts.timeoutMs || ACADZA_TIMEOUT_MS;

  if (!apiUrl) {
    return {
      userId: null,
      token: null,
    };
  }

  try {
    const res = await fetchWithTimeout(
      `${apiUrl}/user/login`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          username,
          password,
        }),
      },
      timeoutMs,
    );

    const data = await res.json();

    if (data.isSuccessful && data.user) {
      const user = data.user;

      return {
        userId: String(user._id ?? user['_id'] ?? '') || null,
        token: String(data.token ?? data['token'] ?? '') || null,
      };
    }

    return {
      userId: null,
      token: null,
    };
  } catch (err) {
    console.error('[acadza login] error:', err.message);

    return {
      userId: null,
      token: null,
    };
  }
};

module.exports = {
  createDost,
  acadzaLogin,
  fetchWithTimeout,
};