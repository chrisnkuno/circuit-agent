"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { authClient } from "@/lib/auth-client";

export function useCurrentOrganization() {
  const membership = useQuery(api.organizations.getCurrentMembership);
  return membership?.organization;
}

export function AuthPanel() {
  const session = authClient.useSession();
  const ensureOrganization = useMutation(api.organizations.ensureOrganization);
  const membership = useQuery(api.organizations.getCurrentMembership, session.data ? {} : "skip");
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (session.data && membership === null) {
      ensureOrganization().catch((err) => setError(err instanceof Error ? err.message : "Could not create a workspace"));
    }
  }, [session.data, membership, ensureOrganization]);

  if (session.isPending) return <div className="auth-panel"><p>Checking session…</p></div>;

  if (session.data) {
    // The workspace name is derived from the email (see ensureOrganization), so printing both
    // is pure duplication — show the identity once and the workspace as a readiness state.
    return <div className="auth-panel signed-in">
      <b title={membership ? membership.organization.name : "Creating your workspace"}>
        <span className={`auth-workspace-dot${membership ? " auth-workspace-ready" : ""}`} />
        {session.data.user.email}
      </b>
      <button className="outline" onClick={() => authClient.signOut()}>Sign out</button>
    </div>;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const result = mode === "signin"
      ? await authClient.signIn.email({ email, password })
      : await authClient.signUp.email({ email, password, name: name || email });
    setPending(false);
    if (result.error) setError(result.error.message ?? "Authentication failed");
  }

  return <form className="auth-panel" onSubmit={submit}>
    <div className="auth-mode">
      <button type="button" className={mode === "signin" ? "selected" : ""} onClick={() => setMode("signin")}>Sign in</button>
      <button type="button" className={mode === "signup" ? "selected" : ""} onClick={() => setMode("signup")}>Sign up</button>
    </div>
    {mode === "signup" && <input placeholder="Name" value={name} onChange={(event) => setName(event.target.value)} />}
    <input type="email" required placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} />
    <input type="password" required minLength={8} placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} />
    <button className="primary" type="submit" disabled={pending}>{mode === "signin" ? "Sign in" : "Create account"}</button>
    {error && <p className="notice">{error}</p>}
  </form>;
}
