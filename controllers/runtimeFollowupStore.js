// runtimeFollowupStore.js

const runtimeFollowups = new Map();

const saveRuntimeFollowup = async (tempSessionId, data) => {
  runtimeFollowups.set(tempSessionId, {
    ...data,
    updated_at: new Date().toISOString(),
    created_at: data.created_at ?? new Date().toISOString(),
  });

  return runtimeFollowups.get(tempSessionId);
};

const getRuntimeFollowup = async (tempSessionId) => {
  return runtimeFollowups.get(tempSessionId) ?? null;
};

const updateRuntimeFollowup = async (tempSessionId, updates) => {
  const existing = runtimeFollowups.get(tempSessionId);

  if (!existing) return null;

  const updated = {
    ...existing,
    ...updates,
    updated_at: new Date().toISOString(),
  };

  runtimeFollowups.set(tempSessionId, updated);

  return updated;
};

const deleteRuntimeFollowup = async (tempSessionId) => {
  return runtimeFollowups.delete(tempSessionId);
};

module.exports = {
  runtimeFollowups,
  saveRuntimeFollowup,
  getRuntimeFollowup,
  updateRuntimeFollowup,
  deleteRuntimeFollowup,
};