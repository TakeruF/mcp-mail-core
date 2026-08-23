import { describe, expect, it, vi } from "vitest";
import { GMAIL_CAPABILITIES, MailError, assertProviderContract, inspectProviderContract, type MailProviderAdapter } from "../src/index.js";

function adapter(overrides: Partial<MailProviderAdapter> = {}): MailProviderAdapter {
  return {
    id: "probe",
    capabilities: { search: true, nativeSearch: false, threads: false, labels: false, folders: false, attachments: false, drafts: false, send: false, reply: false, forward: false, archive: false, trash: false, permanentDelete: false, flags: [] },
    health: vi.fn(async () => ({ status: "ready" as const })),
    search: vi.fn(async () => ({ messages: [] })),
    getMessage: vi.fn(),
    ...overrides,
  };
}

describe("provider contract gate", () => {
  it("accepts a capability-minimal read adapter", () => {
    expect(inspectProviderContract(adapter())).toEqual({ providerId: "probe", valid: true, violations: [] });
  });

  it("rejects advertised capabilities without methods before host use", () => {
    const malformed = adapter({ capabilities: { ...adapter().capabilities, attachments: true, drafts: true } });
    const report = inspectProviderContract(malformed);
    expect(report.valid).toBe(false);
    expect(report.violations).toEqual(expect.arrayContaining([
      "attachments is advertised but getAttachment is missing",
      "drafts is advertised but createDraft is missing",
      "drafts is advertised but updateDraft is missing",
      "drafts is advertised but sendDraft is missing",
    ]));
    expect(() => assertProviderContract(malformed)).toThrow(MailError);
  });

  it("rejects hidden mutation methods and permanent deletion claims", () => {
    const malformed = adapter({
      capabilities: { ...adapter().capabilities, permanentDelete: true },
      trash: vi.fn(async () => undefined),
    });
    expect(inspectProviderContract(malformed).violations).toEqual(expect.arrayContaining([
      "trash is implemented but trash is not advertised",
      "permanentDelete is unsupported by this Core version",
    ]));
  });

  it("describes the Gmail adapter declaration as internally complete", () => {
    const gmailShape = adapter({
      id: "gmail",
      capabilities: GMAIL_CAPABILITIES,
      getThread: vi.fn(), getAttachment: vi.fn(), createDraft: vi.fn(), updateDraft: vi.fn(), sendDraft: vi.fn(),
      send: vi.fn(), reply: vi.fn(), forward: vi.fn(), archive: vi.fn(), trash: vi.fn(), setFlags: vi.fn(),
    });
    expect(inspectProviderContract(gmailShape)).toMatchObject({ valid: true, violations: [] });
  });
});
