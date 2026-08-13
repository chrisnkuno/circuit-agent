"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AuthPanel, useCurrentOrganization } from "@/components/auth-panel";
import { projectNovaGrowth, type GrowthBaseline, type GrowthFeature, type GrowthFeedback } from "@/lib/growth-model";

const emptyBaseline: GrowthBaseline = {
  activeUsers: 0,
  monthlyNewUsers: 0,
  monthlyChurnPercent: 5,
  monthlyRevenueUsd: 0,
  monthlyCostsUsd: 0,
  valuationRevenueMultiple: 5,
};

const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const wholeNumber = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function number(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function Metric({ label, value, note, accent = false }: { label: string; value: string; note: string; accent?: boolean }) {
  return <article className={accent ? "growth-metric growth-metric-accent" : "growth-metric"}><span>{label}</span><strong>{value}</strong><p>{note}</p></article>;
}

export function GrowingNova() {
  const organization = useCurrentOrganization();
  const workspace = useQuery(api.growth.getWorkspace, organization ? { organizationId: organization._id } : "skip");
  const saveBaseline = useMutation(api.growth.saveBaseline);
  const addFeature = useMutation(api.growth.addFeature);
  const addFeedback = useMutation(api.growth.addFeedback);
  const setFeedbackStatus = useMutation(api.growth.setFeedbackStatus);
  const [baseline, setBaseline] = useState(emptyBaseline);
  const [baselineHydrated, setBaselineHydrated] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [feature, setFeature] = useState({ name: "", status: "idea" as const, reachPercent: 40, adoptionPercent: 25, monthlyValuePerAdopterUsd: 50, monthlyRevenuePerAdopterUsd: 8, retentionLiftPercent: 1, evidence: "hypothesis" as const });
  const [feedback, setFeedback] = useState({ source: "User interview", summary: "", kind: "request" as const, affectedUsers: 1, willingnessToPay: "unknown" as const, featureId: "" });

  useEffect(() => {
    if (!workspace || baselineHydrated) return;
    if (workspace.baseline) {
      setBaseline({
        activeUsers: workspace.baseline.activeUsers,
        monthlyNewUsers: workspace.baseline.monthlyNewUsers,
        monthlyChurnPercent: workspace.baseline.monthlyChurnPercent,
        monthlyRevenueUsd: workspace.baseline.monthlyRevenueUsd,
        monthlyCostsUsd: workspace.baseline.monthlyCostsUsd,
        valuationRevenueMultiple: workspace.baseline.valuationRevenueMultiple,
      });
    }
    setBaselineHydrated(true);
  }, [baselineHydrated, workspace]);

  const features: GrowthFeature[] = useMemo(() => (workspace?.features ?? []).map((item) => ({
    id: item._id,
    name: item.name,
    status: item.status,
    reachPercent: item.reachPercent,
    adoptionPercent: item.adoptionPercent,
    monthlyValuePerAdopterUsd: item.monthlyValuePerAdopterUsd,
    monthlyRevenuePerAdopterUsd: item.monthlyRevenuePerAdopterUsd,
    retentionLiftPercent: item.retentionLiftPercent,
    evidence: item.evidence,
  })), [workspace?.features]);
  const feedbackItems: GrowthFeedback[] = useMemo(() => (workspace?.feedback ?? []).map((item) => ({
    id: item._id,
    featureId: item.featureId,
    kind: item.kind,
    affectedUsers: item.affectedUsers,
    willingnessToPay: item.willingnessToPay,
    status: item.status,
  })), [workspace?.feedback]);
  const projection = useMemo(() => projectNovaGrowth(baseline, features, feedbackItems), [baseline, features, feedbackItems]);

  async function persistBaseline(event: React.FormEvent) {
    event.preventDefault();
    if (!organization) return;
    setSaving(true); setNotice(null);
    try {
      await saveBaseline({ organizationId: organization._id, ...baseline });
      setNotice("Measured baseline saved. Every projection now starts from these numbers.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save the baseline."); }
    finally { setSaving(false); }
  }

  async function persistFeature(event: React.FormEvent) {
    event.preventDefault();
    if (!organization || !feature.name.trim()) return;
    setSaving(true); setNotice(null);
    try {
      await addFeature({ organizationId: organization._id, ...feature });
      setFeature((current) => ({ ...current, name: "" }));
      setNotice("Feature added. Its impact is now isolated in the forecast.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not add the feature."); }
    finally { setSaving(false); }
  }

  async function ingestFeedback(event: React.FormEvent) {
    event.preventDefault();
    if (!organization || !feedback.summary.trim()) return;
    setSaving(true); setNotice(null);
    try {
      await addFeedback({
        organizationId: organization._id,
        source: feedback.source,
        summary: feedback.summary,
        kind: feedback.kind,
        affectedUsers: feedback.affectedUsers,
        willingnessToPay: feedback.willingnessToPay,
        featureId: feedback.featureId ? feedback.featureId as Id<"growthFeatures"> : undefined,
      });
      setFeedback((current) => ({ ...current, summary: "" }));
      setNotice("Feedback ingested as a new signal. Validate it before treating it as evidence.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not ingest feedback."); }
    finally { setSaving(false); }
  }

  return <main className="growing-nova-page">
    <header className="growth-topbar">
      <Link href="/" className="growth-brand">CIRCUIT <span>NOVA</span></Link>
      <nav><Link href="/terminal">Agent terminal</Link><AuthPanel /></nav>
    </header>

    <section className="growth-hero">
      <div><p className="growth-kicker">GROWING NOVA / CONTROL ROOM</p><h1>Turn product progress<br />into <em>measurable value.</em></h1></div>
      <p>Connect the numbers you know, the features you plan, and what users actually say. The model shows what changed, why it changed, and how uncertain the estimate still is.</p>
    </section>

    {!organization ? <section className="growth-gate"><p>Sign in to create a durable growth model for your Nova workspace.</p><p>Your forecasts, feature assumptions, and feedback evidence are organization-scoped.</p></section> : <>
      <section className="growth-scoreboard" aria-label="Nova growth forecast">
        <div className="growth-confidence"><span>MODEL CONFIDENCE</span><strong>{projection.confidencePercent}%</strong><div><i style={{ width: `${projection.confidencePercent}%` }} /></div><p>Confidence rises when baseline data is complete and feature assumptions are backed by usage or revenue.</p></div>
        <div className="growth-metrics">
          <Metric label="Active users · month 12" value={wholeNumber.format(projection.month12Users)} note={`from ${wholeNumber.format(baseline.activeUsers)} today`} />
          <Metric label="Revenue · month 12" value={compactUsd.format(projection.month12RevenueUsd)} note={`${wholeUsd.format(projection.month12ProfitUsd)} modeled monthly profit`} />
          <Metric label="Potential valuation" value={compactUsd.format(projection.potentialValuationUsd)} note={`${compactUsd.format(projection.valuationLowUsd)}–${compactUsd.format(projection.valuationHighUsd)} confidence range`} accent />
          <Metric label="Customer value created" value={compactUsd.format(projection.totalMonthlyCustomerValueUsd)} note="per month, across modeled adopters" />
        </div>
      </section>

      {notice && <p className="growth-notice" role="status">{notice}</p>}

      <section className="growth-grid">
        <form className="growth-panel" onSubmit={persistBaseline}>
          <div className="growth-panel-head"><span>01</span><div><h2>Measured baseline</h2><p>The starting line—not a forecast.</p></div></div>
          <div className="growth-form-grid">
            <label>30-day active users<input type="number" min="0" value={baseline.activeUsers} onChange={(event) => setBaseline({ ...baseline, activeUsers: number(event.target.value) })} /></label>
            <label>New users / month<input type="number" min="0" value={baseline.monthlyNewUsers} onChange={(event) => setBaseline({ ...baseline, monthlyNewUsers: number(event.target.value) })} /></label>
            <label>Monthly churn %<input type="number" min="0" max="100" step="0.1" value={baseline.monthlyChurnPercent} onChange={(event) => setBaseline({ ...baseline, monthlyChurnPercent: number(event.target.value) })} /></label>
            <label>Monthly revenue · USD<input type="number" min="0" value={baseline.monthlyRevenueUsd} onChange={(event) => setBaseline({ ...baseline, monthlyRevenueUsd: number(event.target.value) })} /></label>
            <label>Monthly costs · USD<input type="number" min="0" value={baseline.monthlyCostsUsd} onChange={(event) => setBaseline({ ...baseline, monthlyCostsUsd: number(event.target.value) })} /></label>
            <label>Revenue multiple<input type="number" min="0.1" max="100" step="0.1" value={baseline.valuationRevenueMultiple} onChange={(event) => setBaseline({ ...baseline, valuationRevenueMultiple: number(event.target.value) })} /></label>
          </div>
          <button className="growth-action" disabled={saving}>Save measured baseline <span>→</span></button>
        </form>

        <aside className="growth-panel growth-questions">
          <div className="growth-panel-head"><span>NOW</span><div><h2>Insights Nova needs</h2><p>Questions that reduce uncertainty fastest.</p></div></div>
          <ol>{projection.questions.length ? projection.questions.map((question, index) => <li key={question}><b>{String(index + 1).padStart(2, "0")}</b><span>{question}</span></li>) : <li><b>✓</b><span>The core inputs are covered. Validate the weakest feature with another observed signal.</span></li>}</ol>
        </aside>
      </section>

      <section className="growth-panel growth-features">
        <div className="growth-panel-head"><span>02</span><div><h2>Feature value ledger</h2><p>See adoption, revenue, created value, and valuation contribution feature by feature.</p></div></div>
        <form className="feature-form" onSubmit={persistFeature}>
          <label className="wide">Feature name<input required placeholder="e.g. Shared team memory" value={feature.name} onChange={(event) => setFeature({ ...feature, name: event.target.value })} /></label>
          <label>Stage<select value={feature.status} onChange={(event) => setFeature({ ...feature, status: event.target.value as typeof feature.status })}><option value="idea">Idea</option><option value="building">Building</option><option value="shipped">Shipped</option></select></label>
          <label>Evidence<select value={feature.evidence} onChange={(event) => setFeature({ ...feature, evidence: event.target.value as typeof feature.evidence })}><option value="hypothesis">Hypothesis</option><option value="interviews">Interviews</option><option value="usage">Observed usage</option><option value="revenue">Revenue</option></select></label>
          <label>Users reached %<input type="number" min="0" max="100" value={feature.reachPercent} onChange={(event) => setFeature({ ...feature, reachPercent: number(event.target.value) })} /></label>
          <label>Expected adoption %<input type="number" min="0" max="100" value={feature.adoptionPercent} onChange={(event) => setFeature({ ...feature, adoptionPercent: number(event.target.value) })} /></label>
          <label>Value / adopter / mo.<input type="number" min="0" value={feature.monthlyValuePerAdopterUsd} onChange={(event) => setFeature({ ...feature, monthlyValuePerAdopterUsd: number(event.target.value) })} /></label>
          <label>Revenue / adopter / mo.<input type="number" min="0" value={feature.monthlyRevenuePerAdopterUsd} onChange={(event) => setFeature({ ...feature, monthlyRevenuePerAdopterUsd: number(event.target.value) })} /></label>
          <label>Retention lift %<input type="number" min="0" max="100" step="0.1" value={feature.retentionLiftPercent} onChange={(event) => setFeature({ ...feature, retentionLiftPercent: number(event.target.value) })} /></label>
          <button className="growth-action" disabled={saving}>Add to forecast <span>＋</span></button>
        </form>
        <div className="feature-ledger" role="table" aria-label="Feature projections">
          <div className="feature-row feature-row-head" role="row"><span>Feature / confidence</span><span>Adopters</span><span>Monthly revenue</span><span>Created value</span><span>Valuation lift</span></div>
          {features.length === 0 ? <p className="growth-empty">No features yet. Add the next meaningful Nova capability to see its isolated impact.</p> : features.map((item) => {
            const impact = projection.featureProjections.find((candidate) => candidate.featureId === item.id)!;
            return <div className="feature-row" role="row" key={item.id}><span><b>{item.name}</b><small>{item.status} · {impact.confidencePercent}% confidence</small></span><span>{wholeNumber.format(impact.adopters)}</span><span>{wholeUsd.format(impact.incrementalMonthlyRevenueUsd)}</span><span>{wholeUsd.format(impact.monthlyCustomerValueUsd)}</span><span className="positive">+{compactUsd.format(impact.valuationLiftUsd)}</span></div>;
          })}
        </div>
      </section>

      <section className="growth-grid growth-feedback-grid">
        <form className="growth-panel" onSubmit={ingestFeedback}>
          <div className="growth-panel-head"><span>03</span><div><h2>Feedback intake</h2><p>Raw feedback starts as a signal, not proof.</p></div></div>
          <div className="growth-form-grid">
            <label>Source<input required value={feedback.source} onChange={(event) => setFeedback({ ...feedback, source: event.target.value })} /></label>
            <label>Signal type<select value={feedback.kind} onChange={(event) => setFeedback({ ...feedback, kind: event.target.value as typeof feedback.kind })}><option value="problem">Problem</option><option value="request">Request</option><option value="praise">Praise</option></select></label>
            <label>Linked feature<select value={feedback.featureId} onChange={(event) => setFeedback({ ...feedback, featureId: event.target.value })}><option value="">Unlinked signal</option>{features.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <label>Affected users<input type="number" min="1" value={feedback.affectedUsers} onChange={(event) => setFeedback({ ...feedback, affectedUsers: number(event.target.value) })} /></label>
            <label>Willingness to pay<select value={feedback.willingnessToPay} onChange={(event) => setFeedback({ ...feedback, willingnessToPay: event.target.value as typeof feedback.willingnessToPay })}><option value="unknown">Not asked</option><option value="no">No</option><option value="maybe">Maybe</option><option value="yes">Yes</option></select></label>
            <label className="full">What did they say?<textarea required rows={4} placeholder="Capture the outcome they need, not only the feature they requested." value={feedback.summary} onChange={(event) => setFeedback({ ...feedback, summary: event.target.value })} /></label>
          </div>
          <button className="growth-action" disabled={saving}>Ingest signal <span>→</span></button>
        </form>
        <aside className="growth-panel signal-stream">
          <div className="growth-panel-head"><span>LIVE</span><div><h2>Evidence stream</h2><p>Validate signals only after a follow-up.</p></div></div>
          <div className="signal-list">{(workspace?.feedback ?? []).length === 0 ? <p className="growth-empty">Feedback will appear here with its evidence status.</p> : (workspace?.feedback ?? []).slice(0, 8).map((item) => <article key={item._id}><div><span className={`signal-kind signal-${item.kind}`}>{item.kind}</span><small>{item.source} · {item.affectedUsers} user{item.affectedUsers === 1 ? "" : "s"}</small></div><p>{item.summary}</p><div className="signal-actions"><span>{item.willingnessToPay === "unknown" ? "payment intent unknown" : `would pay: ${item.willingnessToPay}`}</span>{item.status === "new" ? <button onClick={() => void setFeedbackStatus({ feedbackId: item._id, status: "validated" })}>Mark validated</button> : <b>{item.status.replace("_", " ")}</b>}</div></article>)}</div>
        </aside>
      </section>

      <footer className="growth-method"><b>How to read this model</b><p>Valuation is a scenario, not an appraisal: projected month-12 revenue × your selected annual revenue multiple. Feature confidence discounts adoption until evidence improves. The range widens when inputs are missing. Customer value is tracked separately from Nova’s captured revenue so value creation cannot be confused with money earned.</p></footer>
    </>}
  </main>;
}
