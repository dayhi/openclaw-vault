export function splitPathSegments(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

export function countPathOverlap(baseSegments: string[], requestSegments: string[]): number {
  const maxOverlap = Math.min(baseSegments.length, requestSegments.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const baseTail = baseSegments.slice(baseSegments.length - overlap);
    const requestHead = requestSegments.slice(0, overlap);
    if (baseTail.join("/") === requestHead.join("/")) {
      return overlap;
    }
  }
  return 0;
}

export function buildProxyUrl(port: number, providerId: string): string {
  return `http://127.0.0.1:${port}/${providerId}`;
}

export function isProxyUrlForProvider(input: string, port: number, providerId: string): boolean {
  try {
    const url = new URL(input);
    return url.toString().replace(/\/+$/, "") === buildProxyUrl(port, providerId);
  } catch {
    return false;
  }
}

export function stripProviderPrefixFromPath(params: {
  pathname: string;
  providerId: string;
}): string {
  const prefix = `/${params.providerId}`;
  if (params.pathname === prefix) {
    return "";
  }
  if (params.pathname.startsWith(`${prefix}/`)) {
    return params.pathname.slice(prefix.length + 1);
  }
  throw new Error(`request path does not match provider route: ${params.pathname}`);
}

export function buildUpstreamUrl(params: {
  originalBaseUrlRaw: string;
  requestSuffixPath: string;
  search?: string;
}): URL {
  const baseUrl = new URL(params.originalBaseUrlRaw);
  const baseSegments = splitPathSegments(baseUrl.pathname);
  const requestSegments = splitPathSegments(params.requestSuffixPath);
  const overlap = countPathOverlap(baseSegments, requestSegments);
  const mergedSegments = [...baseSegments, ...requestSegments.slice(overlap)];

  const upstreamUrl = new URL(baseUrl.toString());
  upstreamUrl.pathname = mergedSegments.length > 0 ? `/${mergedSegments.join("/")}` : "/";
  upstreamUrl.search = params.search ?? "";
  upstreamUrl.hash = "";
  return upstreamUrl;
}
