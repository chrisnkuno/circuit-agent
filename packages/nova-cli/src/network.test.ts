import { describe, expect, it } from "vitest";
import { classifyNetworkError } from "./network";

/** Builds the error shapes the transport layers actually throw. */
function transportError(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

describe("network error classification", () => {
  it("returns null for errors that have nothing to do with the network", () => {
    expect(classifyNetworkError(new Error("Model response did not contain a JSON object"))).toBeNull();
    expect(classifyNetworkError(new Error("Session budget exhausted"))).toBeNull();
    expect(classifyNetworkError("a string thrown by a tool")).toBeNull();
  });

  it("turns a provider 404 into a base-route and model diagnosis", () => {
    const error = Object.assign(new Error("404 Not Found"), { status: 404, name: "NotFoundError" });
    const diagnosis = classifyNetworkError(error, { host: "api.circuitnotion.com", purpose: "the model API (CircuitNotion)" });
    expect(diagnosis?.kind).toBe("not_found");
    expect(diagnosis?.message).toContain("API route or selected model");
    expect(diagnosis?.hint).toContain("/v1");
    expect(diagnosis?.hint).toContain("/models");
  });

  it("names the host and purpose for a DNS failure", () => {
    const diagnosis = classifyNetworkError(
      transportError("getaddrinfo ENOTFOUND api.circuitnotion.com", "ENOTFOUND"),
      { host: "api.circuitnotion.com", purpose: "the model API (CircuitNotion)" },
    );
    expect(diagnosis?.kind).toBe("dns");
    expect(diagnosis?.message).toContain("api.circuitnotion.com");
    expect(diagnosis?.message).toContain("the model API");
    expect(diagnosis?.hint).toContain("--doctor");
  });

  it("unwraps Node's `fetch failed` wrapper and classifies the cause", () => {
    const cause = transportError("getaddrinfo EAI_AGAIN registry.npmjs.org", "EAI_AGAIN");
    const wrapped = transportError("fetch failed", "", cause);
    const diagnosis = classifyNetworkError(wrapped, { purpose: "the self-update check" });
    expect(diagnosis?.kind).toBe("dns");
    expect(diagnosis?.message).toContain("registry.npmjs.org");
  });

  it("classifies timeouts, including undici's connect timeout and AbortSignal.timeout", () => {
    expect(classifyNetworkError(transportError("connect ETIMEDOUT 10.0.0.1:443", "ETIMEDOUT"), { host: "api.circuitnotion.com" })?.kind).toBe("timeout");
    expect(classifyNetworkError(transportError("connect timeout", "UND_ERR_CONNECT_TIMEOUT"), { host: "cdn.jsdelivr.net" })?.kind).toBe("timeout");
    const aborted = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(classifyNetworkError(aborted, { host: "api.openai.com" })?.kind).toBe("timeout");
  });

  it("distinguishes refused, reset and unreachable connections", () => {
    expect(classifyNetworkError(transportError("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED"), { host: "relay.example.com" })?.kind).toBe("refused");
    expect(classifyNetworkError(transportError("read ECONNRESET", "ECONNRESET"), { host: "api.exa.ai" })?.kind).toBe("reset");
    expect(classifyNetworkError(transportError("connect ENETUNREACH", "ENETUNREACH"), { host: "api.anthropic.com" })?.kind).toBe("unreachable");
  });

  it("names a TLS interception for certificate errors", () => {
    const diagnosis = classifyNetworkError(transportError("self signed certificate in certificate chain", "DEPTH_ZERO_SELF_SIGNED_CERT"), { host: "api.circuitnotion.com" });
    expect(diagnosis?.kind).toBe("tls");
    expect(diagnosis?.message).toContain("TLS certificate");
    expect(diagnosis?.hint).toContain("proxy");
  });

  it("classifies the SDK connection-error wrapper by its cause", () => {
    const sdkError = Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
      cause: transportError("connect ECONNREFUSED", "ECONNREFUSED"),
    });
    const diagnosis = classifyNetworkError(sdkError, { host: "api.openai.com", purpose: "the model API" });
    expect(diagnosis?.kind).toBe("refused");
    expect(diagnosis?.message).toContain("api.openai.com");
  });

  it("does not blame the network for a user-initiated abort", () => {
    const cancelled = Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
    expect(classifyNetworkError(cancelled)).toBeNull();
  });
});
