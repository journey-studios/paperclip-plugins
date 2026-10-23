function metric(lhr, name) {
  const value = lhr.audits?.[name]?.numericValue;
  if (!Number.isFinite(value) || value < 0) throw new Error("INVALID_METRIC");
  return value;
}
export function sampleOf(lhr, proof, target, before, after, cache, index) {
  if (lhr.lighthouseVersion !== "13.4.1" || lhr.runtimeError) throw new Error("LIGHTHOUSE_INVALID");
  const score = lhr.categories?.performance?.score;
  if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error("INVALID_SCORE");
  const expected = new URL(target.url);
  const final = new URL(lhr.finalDisplayedUrl || lhr.finalUrl);
  if (final.origin !== expected.origin || final.pathname !== expected.pathname) throw new Error("AUTH_OR_ROUTE_INVALID");
  const requests = lhr.audits?.["network-requests"]?.details?.items;
  if (!Array.isArray(requests) || !requests.length) throw new Error("EMPTY_NETWORK_EVIDENCE");
  const document = requests.find((item) => {
    try { const url = new URL(item.url); return item.resourceType === "Document" && url.origin === expected.origin && url.pathname === expected.pathname; }
    catch { return false; }
  });
  if (document?.statusCode !== 200) throw new Error("DOCUMENT_NOT_200");
  if (!before || before !== after) throw new Error("BUILD_CHANGED");
  if (!proof.cacheVerified || proof.cache !== cache) throw new Error("CACHE_NOT_VERIFIED");
  let authVerified = true;
  if (target.authProfile !== "public") {
    authVerified = requests.some((item) => {
      try { const url = new URL(item.url); return /\/(threads|conversations)(\/|$)/.test(url.pathname) && item.statusCode === 200; }
      catch { return false; }
    });
    if (!authVerified || !proof.auditReadyVerified || !proof.auditHistoryVerified) throw new Error("AUTH_EVIDENCE_REQUIRED");
  }
  const bytes = requests.reduce((sum, item) => sum + Math.max(0, Number(item.transferSize) || 0), 0);
  return { cache, index, valid: true, documentStatus: 200, routeVerified: true, authVerified,
    readyVerified: proof.auditReadyVerified, historyVerified: proof.auditHistoryVerified, buildStable: true,
    cacheVerified: true, buildId: before, score: score * 100,
    fcp: metric(lhr, "first-contentful-paint"), lcp: metric(lhr, "largest-contentful-paint"),
    tbt: metric(lhr, "total-blocking-time"), cls: metric(lhr, "cumulative-layout-shift"),
    bytes, requests: requests.length, uiReadyMs: proof.uiReadyMs };
}
