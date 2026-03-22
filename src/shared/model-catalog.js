function extractModelCatalogFromListResponse(response) {
  const candidates = Array.isArray(response?.result?.data)
    ? response.result.data
    : Array.isArray(response?.data)
      ? response.data
      : [];
  return normalizeModelCatalog(candidates);
}

function resolveEffectiveModelForEffort(models, currentModel) {
  if (!Array.isArray(models) || !models.length) {
    return null;
  }
  const normalizedCurrent = normalizeText(currentModel).toLowerCase();
  if (normalizedCurrent) {
    const matched = findModelByQuery(models, normalizedCurrent);
    if (matched) {
      return matched;
    }
  }
  return models.find((item) => item.isDefault) || models[0];
}

function findModelByQuery(models, query) {
  const normalizedQuery = normalizeText(query).toLowerCase();
  if (!normalizedQuery || !Array.isArray(models)) {
    return null;
  }
  return models.find((item) => (
    normalizeText(item?.model).toLowerCase() === normalizedQuery
    || normalizeText(item?.id).toLowerCase() === normalizedQuery
  )) || null;
}

function normalizeModelCatalog(models) {
  if (!Array.isArray(models)) {
    return [];
  }
  const normalized = [];
  const seen = new Set();
  for (const model of models) {
    if (!model || typeof model !== "object") {
      continue;
    }
    const modelId = normalizeText(model.model);
    const id = normalizeText(model.id);
    const normalizedModel = modelId || id;
    if (!normalizedModel) {
      continue;
    }
    const dedupeKey = normalizedModel.toLowerCase();
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    normalized.push({
      id,
      model: normalizedModel,
      displayName: normalizeText(model.displayName || model.display_name),
      supportedReasoningEfforts: normalizeReasoningEfforts(
        model.supportedReasoningEfforts || model.supported_reasoning_efforts
      ),
      defaultReasoningEffort: normalizeText(model.defaultReasoningEffort || model.default_reasoning_effort),
      isDefault: !!(model.isDefault || model.is_default),
    });
  }
  return normalized;
}

function normalizeReasoningEfforts(efforts) {
  if (!Array.isArray(efforts)) {
    return [];
  }
  const result = [];
  const seen = new Set();
  for (const effort of efforts) {
    const normalized = normalizeText(
      typeof effort === "string"
        ? effort
        : effort?.reasoningEffort || effort?.reasoning_effort
    );
    if (!normalized) {
      continue;
    }
    const key = normalized.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }
  return result;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

module.exports = {
  extractModelCatalogFromListResponse,
  findModelByQuery,
  normalizeModelCatalog,
  normalizeText,
  resolveEffectiveModelForEffort,
};
