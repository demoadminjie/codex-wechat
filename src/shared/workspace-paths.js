const path = require("path");

const WINDOWS_DRIVE_PATH_RE = /^[A-Za-z]:\//;
const WINDOWS_DRIVE_ROOT_RE = /^[A-Za-z]:\/$/;
const WINDOWS_UNC_PREFIX_RE = /^\/\/\?\//;

function normalizeWorkspacePath(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }

  const fromFileUri = extractPathFromFileUri(normalized);
  const rawPath = fromFileUri || normalized;
  const withForwardSlashes = rawPath.replace(/\\/g, "/").replace(WINDOWS_UNC_PREFIX_RE, "");
  const normalizedDrivePrefix = /^\/[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes.slice(1)
    : withForwardSlashes;

  if (WINDOWS_DRIVE_ROOT_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalizedDrivePrefix)) {
    return normalizedDrivePrefix.replace(/\/+$/g, "");
  }
  return normalizedDrivePrefix.replace(/\/+$/g, "");
}

function isAbsoluteWorkspacePath(workspaceRoot) {
  const normalized = normalizeWorkspacePath(workspaceRoot);
  if (!normalized) {
    return false;
  }
  if (WINDOWS_DRIVE_PATH_RE.test(normalized)) {
    return true;
  }
  return path.posix.isAbsolute(normalized);
}

function pathMatchesWorkspaceRoot(candidatePath, workspaceRoot) {
  const normalizedCandidate = normalizeWorkspacePath(candidatePath);
  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  if (!normalizedCandidate || !normalizedWorkspaceRoot) {
    return false;
  }

  const compareCandidate = normalizeComparableWorkspacePath(normalizedCandidate);
  const compareWorkspaceRoot = normalizeComparableWorkspacePath(normalizedWorkspaceRoot);
  if (compareCandidate === compareWorkspaceRoot) {
    return true;
  }

  return workspacePathStartsWith(compareCandidate, compareWorkspaceRoot);
}

function isWorkspaceAllowed(workspaceRoot, allowlist) {
  if (!Array.isArray(allowlist) || allowlist.length === 0) {
    return true;
  }

  const normalizedWorkspaceRoot = normalizeWorkspacePath(workspaceRoot);
  const compareWorkspaceRoot = normalizeComparableWorkspacePath(normalizedWorkspaceRoot);

  return allowlist.some((allowedRoot) => {
    const normalizedAllowedRoot = normalizeWorkspacePath(allowedRoot);
    const compareAllowedRoot = normalizeComparableWorkspacePath(normalizedAllowedRoot);
    return compareWorkspaceRoot === compareAllowedRoot
      || workspacePathStartsWith(compareWorkspaceRoot, compareAllowedRoot);
  });
}

function filterThreadsByWorkspaceRoot(threads, workspaceRoot) {
  return threads.filter((thread) => pathMatchesWorkspaceRoot(thread.cwd, workspaceRoot));
}

function shouldComparePathCaseInsensitive(pathValue) {
  return isWindowsStylePath(pathValue);
}

function normalizeComparableWorkspacePath(pathValue) {
  return shouldComparePathCaseInsensitive(pathValue) ? pathValue.toLowerCase() : pathValue;
}

function extractPathFromFileUri(value) {
  const input = String(value || "").trim();
  if (!/^file:\/\//i.test(input)) {
    return "";
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol !== "file:") {
      return "";
    }
    const pathname = decodeURIComponent(parsed.pathname || "");
    const withHost = parsed.host && parsed.host !== "localhost"
      ? `//${parsed.host}${pathname}`
      : pathname;
    return withHost;
  } catch {
    return "";
  }
}

function isWindowsStylePath(value) {
  return WINDOWS_DRIVE_PATH_RE.test(String(value || ""));
}

function workspacePathStartsWith(candidatePath, workspaceRoot) {
  return candidatePath.startsWith(`${workspaceRoot}/`);
}

module.exports = {
  filterThreadsByWorkspaceRoot,
  isAbsoluteWorkspacePath,
  isWorkspaceAllowed,
  normalizeWorkspacePath,
  pathMatchesWorkspaceRoot,
};
