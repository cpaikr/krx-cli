import { beforeEach, describe, expect, it, vi } from "vitest";
import { krxFetch, BASE_URL } from "../../src/client/client.js";
import { reserveCall } from "../../src/client/rate-limit.js";
import { getCached, setCached } from "../../src/cache/store.js";

vi.mock("../../src/client/rate-limit.js", () => ({
  reserveCall: vi.fn(),
}));

vi.mock("../../src/cache/store.js", () => ({
  getCached: vi.fn(),
  setCached: vi.fn(),
}));

const mockedReserveCall = vi.mocked(reserveCall);
const mockedGetCached = vi.mocked(getCached);
const mockedSetCached = vi.mocked(setCached);

function response(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("krxFetch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    mockedReserveCall.mockReset();
    mockedGetCached.mockReset();
    mockedGetCached.mockReturnValue(null);
    mockedSetCached.mockReset();
    mockedReserveCall.mockResolvedValue({
      date: "20260313",
      count: 1,
      limit: 10_000,
      remaining: 9_999,
      allowed: true,
      warning: false,
      advisory: true,
      reserved: true,
    });
  });

  it("returns a fresh cache hit without quota or network use", async () => {
    mockedGetCached.mockReturnValue([{ A: "cached" }]);
    vi.stubGlobal("fetch", vi.fn());

    await expect(
      krxFetch({
        endpoint: "/svc/apis/idx/kospi_dd_trd",
        params: { basDd: "20240105" },
        apiKey: "key",
      }),
    ).resolves.toMatchObject({ data: [{ A: "cached" }] });

    expect(mockedReserveCall).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refreshes only the matching entry after a successful network fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(200, { OutBlock_1: [{ A: "new" }] })),
    );
    const endpoint = "/svc/apis/idx/kospi_dd_trd";
    const params = { basDd: "20240105" };

    const result = await krxFetch({
      endpoint,
      params,
      apiKey: "key",
      refresh: true,
    });

    expect(result).toMatchObject({ data: [{ A: "new" }] });
    expect(mockedGetCached).not.toHaveBeenCalled();
    expect(mockedReserveCall).toHaveBeenCalledTimes(1);
    expect(mockedSetCached).toHaveBeenCalledWith(endpoint, params, [
      { A: "new" },
    ]);
  });

  it("does not write when cache use is disabled", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(200, { OutBlock_1: [{ A: "new" }] })),
    );

    await krxFetch({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      params: { basDd: "20240105" },
      apiKey: "key",
      cache: false,
    });

    expect(mockedGetCached).not.toHaveBeenCalled();
    expect(mockedSetCached).not.toHaveBeenCalled();
  });

  it("reserves quota before sending the authenticated POST", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(200, { OutBlock_1: [{ A: "1" }] })),
    );
    const result = await krxFetch({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      params: { basDd: "20240105" },
      apiKey: "test-key",
      cache: false,
    });

    expect(mockedReserveCall).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `${BASE_URL}/svc/apis/idx/kospi_dd_trd`,
      expect.objectContaining({
        method: "POST",
        headers: {
          AUTH_KEY: "test-key",
          "Content-Type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ basDd: "20240105" }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result).toMatchObject({ success: true, data: [{ A: "1" }] });
  });

  it("does not retry a permanent 4xx and classifies it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response(403, { respMsg: "Forbidden" })),
    );
    const result = await krxFetch({
      endpoint: "/svc/apis/esg/esg_index_info",
      params: { basDd: "20240105" },
      apiKey: "key",
      cache: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mockedReserveCall).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      success: false,
      errorType: "approval",
      httpStatus: 403,
    });
  });

  it("retries a transient status and reserves each actual attempt", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(response(503, { error: "busy" }))
        .mockResolvedValueOnce(response(200, { OutBlock_1: [] })),
    );
    const pending = krxFetch({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      params: { basDd: "20240105" },
      apiKey: "key",
      cache: false,
      retries: 1,
    });
    await vi.runAllTimersAsync();
    expect((await pending).success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mockedReserveCall).toHaveBeenCalledTimes(2);
  });

  it("retries a network failure while reading the response body", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers(),
          text: () => Promise.reject(new TypeError("body stream reset")),
        })
        .mockResolvedValueOnce(response(200, { OutBlock_1: [{ A: "1" }] })),
    );

    const pending = krxFetch({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      params: { basDd: "20240105" },
      apiKey: "key",
      cache: false,
      retries: 1,
    });
    await vi.runAllTimersAsync();

    await expect(pending).resolves.toMatchObject({ success: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mockedReserveCall).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled response body, not only response headers", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        headers: new Headers(),
        text: () => new Promise<string>(() => undefined),
      }),
    );
    const pending = krxFetch({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      params: { basDd: "20240105" },
      apiKey: "key",
      cache: false,
      retries: 0,
      attemptTimeoutMs: 20,
      overallTimeoutMs: 100,
    });
    const expectation = expect(pending).resolves.toMatchObject({
      success: false,
      errorType: "timeout",
      errorCode: "TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(20);
    await expectation;
  });

  it("cancels before dispatch without consuming quota", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", vi.fn());
    const result = await krxFetch({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      params: { basDd: "20240105" },
      apiKey: "key",
      cache: false,
      signal: controller.signal,
    });
    expect(result.errorType).toBe("cancelled");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("classifies quota persistence failures as local state errors", async () => {
    mockedReserveCall.mockRejectedValueOnce(new Error("invalid quota JSON"));
    vi.stubGlobal("fetch", vi.fn());

    const result = await krxFetch({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      params: { basDd: "20240105" },
      apiKey: "key",
      cache: false,
    });

    expect(result).toMatchObject({
      success: false,
      errorType: "local_state",
      errorCode: "LOCAL_STATE",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not misclassify unexpected fetch failures as quota corruption", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("remote connection closed")),
    );

    const result = await krxFetch({
      endpoint: "/svc/apis/idx/kospi_dd_trd",
      params: { basDd: "20240105" },
      apiKey: "key",
      cache: false,
    });

    expect(result).toMatchObject({
      success: false,
      errorType: "upstream",
      errorCode: "UPSTREAM",
    });
  });
});
