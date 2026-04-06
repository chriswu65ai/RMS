export const stripTrailingSlashes = (value: string): string => value.replace(/\/+$/, '');

const hasSupportedProtocol = (protocol: string): boolean => protocol === 'http:' || protocol === 'https:';

type EndpointUrlValidationOptions = {
  stripSearxngSearchPath?: boolean;
};

const normalizePathname = (pathname: string, options?: EndpointUrlValidationOptions): string => {
  const stripSearxngSearchPath = options?.stripSearxngSearchPath ?? false;
  if (stripSearxngSearchPath && /^\/search\/?$/i.test(pathname)) return '';
  if (pathname === '/') return '';
  return stripTrailingSlashes(pathname);
};

export const validateEndpointUrl = (
  value: string,
  label: string,
  options?: EndpointUrlValidationOptions,
): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return `${label} is required.`;
  try {
    const parsed = new URL(trimmed);
    if (!hasSupportedProtocol(parsed.protocol)) return `${label} must use http:// or https://.`;
    if (!parsed.hostname) return `${label} must include a hostname.`;
    normalizePathname(parsed.pathname, options);
    return null;
  } catch {
    return `${label} must be a valid URL.`;
  }
};

export const normalizeEndpointUrl = (value: string, fallback: string, options?: EndpointUrlValidationOptions): string => {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    const parsed = new URL(trimmed);
    if (!hasSupportedProtocol(parsed.protocol) || !parsed.hostname) return trimmed;
    const normalizedPathname = normalizePathname(parsed.pathname, options);
    return `${parsed.protocol}//${parsed.host}${normalizedPathname}`;
  } catch {
    return trimmed;
  }
};
