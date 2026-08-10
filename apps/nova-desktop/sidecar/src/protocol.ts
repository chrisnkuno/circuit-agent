/** Shared IPC types between the React UI, Tauri shell, and Node sidecar. */
export const CIRCUITNOTION_DEFAULT_BASE_URL = "https://api.circuitnotion.com/v1";
export const DEFAULT_MODELS = {
    circuitnotion: "gpt-5.6-luna",
    openai: "gpt-5.6-terra",
    anthropic: "claude-opus-5",
};
export function defaultSettings() {
    return {
        provider: "circuitnotion",
        apiKey: "",
        baseUrl: CIRCUITNOTION_DEFAULT_BASE_URL,
        model: DEFAULT_MODELS.circuitnotion,
        currency: "RWF",
        fxRwfPerUsd: 1320,
    };
}
