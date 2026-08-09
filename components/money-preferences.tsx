"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { LocateFixed, MapPin, X } from "lucide-react";
import { api } from "@/convex/_generated/api";
import {
  COUNTRY_OPTIONS,
  CURRENCY_OPTIONS,
  countryFromLocale,
  currencyForCountry,
  formatConvertedRwf,
  type MoneyPreference,
} from "@/lib/money";
import { formatRwf } from "@/lib/task-cost";

const STORAGE_KEY = "circuit-nova-money-preferences-v1";
const RATE_KEY_PREFIX = "circuit-nova-fx-v1:";
const DEFAULT_PREFERENCE: MoneyPreference = { countryCode: "RW", currencyCode: "RWF", source: "automatic" };

type MoneyContextValue = {
  preference: MoneyPreference;
  rate: number | null;
  rateDate: string | null;
  rateLoading: boolean;
  rateError: boolean;
  syncError: boolean;
  formatMoney: (valueRwf: number) => string;
  formatApprovalMoney: (valueRwf: number) => string;
  updatePreference: (preference: MoneyPreference) => Promise<void>;
  detectLocation: () => Promise<void>;
};

const MoneyContext = createContext<MoneyContextValue | null>(null);

function readStoredPreference(): MoneyPreference | null {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<MoneyPreference> | null;
    if (!parsed || !/^[A-Z]{2}$/.test(parsed.countryCode ?? "") || !/^[A-Z]{3}$/.test(parsed.currencyCode ?? "")) return null;
    return { countryCode: parsed.countryCode!, currencyCode: parsed.currencyCode!, source: parsed.source === "manual" ? "manual" : "automatic" };
  } catch {
    return null;
  }
}

export function MoneyPreferencesProvider({ children }: { children: ReactNode }) {
  const membership = useQuery(api.organizations.getCurrentMembership);
  const persistPreference = useMutation(api.organizations.updateMoneyPreferences);
  const [preference, setPreference] = useState<MoneyPreference>(DEFAULT_PREFERENCE);
  const [hydrated, setHydrated] = useState(false);
  const [rate, setRate] = useState<number | null>(1);
  const [rateDate, setRateDate] = useState<string | null>(null);
  const [rateLoading, setRateLoading] = useState(false);
  const [rateError, setRateError] = useState(false);
  const [syncError, setSyncError] = useState(false);
  const lastPersistedRef = useRef<string | null>(null);

  const applyPreference = useCallback(async (next: MoneyPreference, persist = true) => {
    const normalized = { ...next, countryCode: next.countryCode.toUpperCase(), currencyCode: next.currencyCode.toUpperCase() };
    setPreference(normalized);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    if (persist && membership) {
      const key = `${normalized.countryCode}:${normalized.currencyCode}:${normalized.source}`;
      if (lastPersistedRef.current !== key) {
        try {
          await persistPreference({ countryCode: normalized.countryCode, currencyCode: normalized.currencyCode, source: normalized.source });
          lastPersistedRef.current = key;
          setSyncError(false);
        } catch {
          // The device preference still works; make failed account sync visible in the popover.
          setSyncError(true);
        }
      }
    }
  }, [membership, persistPreference]);

  const detectLocation = useCallback(async () => {
    let countryCode: string | null = null;
    try {
      const response = await fetch("/api/location");
      if (response.ok) countryCode = ((await response.json()) as { countryCode?: string | null }).countryCode ?? null;
    } catch {
      // Browser locale below is the privacy-preserving fallback when deployment metadata is absent.
    }
    countryCode ??= countryFromLocale(navigator.language);
    countryCode ??= "RW";
    await applyPreference({ countryCode, currencyCode: currencyForCountry(countryCode) ?? "RWF", source: "automatic" });
  }, [applyPreference]);

  useEffect(() => {
    const stored = readStoredPreference();
    if (stored) setPreference(stored);
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    const saved = membership?.membership;
    if (saved?.countryCode && saved.currencyCode && saved.currencySource) {
      const remote: MoneyPreference = { countryCode: saved.countryCode, currencyCode: saved.currencyCode, source: saved.currencySource };
      const key = `${remote.countryCode}:${remote.currencyCode}:${remote.source}`;
      lastPersistedRef.current = key;
      setPreference(remote);
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(remote));
      return;
    }
    const stored = readStoredPreference();
    if (stored) {
      // A preference chosen before sign-in follows the person into their new workspace.
      void applyPreference(stored);
    } else {
      void detectLocation();
    }
  }, [applyPreference, detectLocation, hydrated, membership]);

  useEffect(() => {
    if (!hydrated) return;
    if (preference.currencyCode === "RWF") {
      setRate(1); setRateDate(null); setRateError(false); setRateLoading(false);
      return;
    }
    const cacheKey = `${RATE_KEY_PREFIX}${preference.currencyCode}`;
    try {
      const cached = JSON.parse(window.localStorage.getItem(cacheKey) ?? "null") as { rate?: number; date?: string; fetchedAt?: number } | null;
      if (cached?.rate && cached.fetchedAt && Date.now() - cached.fetchedAt < 7 * 86_400_000) {
        setRate(cached.rate); setRateDate(cached.date ?? null);
      } else setRate(null);
    } catch { setRate(null); }
    setRateLoading(true); setRateError(false);
    fetch(`/api/fx?currency=${encodeURIComponent(preference.currencyCode)}`)
      .then(async (response) => {
        if (!response.ok) throw new Error("rate unavailable");
        return response.json() as Promise<{ rate: number; date: string | null }>;
      })
      .then((result) => {
        setRate(result.rate); setRateDate(result.date); setRateError(false);
        window.localStorage.setItem(cacheKey, JSON.stringify({ ...result, fetchedAt: Date.now() }));
      })
      .catch(() => setRateError(true))
      .finally(() => setRateLoading(false));
  }, [hydrated, preference.currencyCode]);

  const value = useMemo<MoneyContextValue>(() => {
    const formatMoney = (valueRwf: number) => formatConvertedRwf(valueRwf, preference.currencyCode, rate, typeof navigator === "undefined" ? undefined : navigator.language);
    return {
      preference, rate, rateDate, rateLoading, rateError, syncError, formatMoney,
      formatApprovalMoney: (valueRwf) => preference.currencyCode === "RWF" || rate === null
        ? formatRwf(valueRwf)
        : `≈${formatMoney(valueRwf)} (${formatRwf(valueRwf)} ledger)`,
      updatePreference: (next) => applyPreference(next),
      detectLocation,
    };
  }, [applyPreference, detectLocation, preference, rate, rateDate, rateError, rateLoading, syncError]);

  return <MoneyContext.Provider value={value}>{children}</MoneyContext.Provider>;
}

export function useMoney() {
  const value = useContext(MoneyContext);
  if (!value) throw new Error("useMoney must be used inside MoneyPreferencesProvider");
  return value;
}

export function MoneyPreferencesButton() {
  const { preference, rate, rateDate, rateLoading, rateError, syncError, updatePreference, detectLocation } = useMoney();
  const [open, setOpen] = useState(false);
  const countryName = COUNTRY_OPTIONS.find(([code]) => code === preference.countryCode)?.[1] ?? preference.countryCode;
  return (
    <div className="money-preferences">
      <button type="button" className="money-trigger" aria-label="Location and currency" title="Location and currency" onClick={() => setOpen((value) => !value)}>
        <MapPin size={13} aria-hidden="true" /> {preference.currencyCode}
      </button>
      {open && (
        <div className="money-popover" role="dialog" aria-label="Location and currency settings">
          <div className="money-popover-head"><div><b>Local spending</b><span>Ledger stays in RWF</span></div><button type="button" aria-label="Close currency settings" onClick={() => setOpen(false)}><X size={14} /></button></div>
          <label>Location<select value={preference.countryCode} onChange={(event) => { const countryCode = event.target.value; void updatePreference({ countryCode, currencyCode: currencyForCountry(countryCode) ?? preference.currencyCode, source: "manual" }); }}>{COUNTRY_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
          <label>Display currency<select value={preference.currencyCode} onChange={(event) => void updatePreference({ ...preference, currencyCode: event.target.value, source: "manual" })}>{CURRENCY_OPTIONS.map((currency) => <option key={currency} value={currency}>{currency}</option>)}</select></label>
          <button type="button" className="money-detect" onClick={() => void detectLocation()}><LocateFixed size={13} /> Detect my location</button>
          <p>{preference.source === "automatic" ? `Automatically set for ${countryName}.` : `Manually set to ${countryName}.`} {rateLoading ? "Refreshing exchange rate…" : rateError ? rate === null ? "Live rate unavailable; RWF is shown safely." : "Live refresh unavailable; using the last saved daily rate." : preference.currencyCode === "RWF" ? "No conversion needed." : `Approximate daily rate${rateDate ? ` from ${rateDate}` : ""}.`} {syncError ? "Saved on this device; account sync needs retrying." : ""}</p>
        </div>
      )}
    </div>
  );
}
