import type { Metadata } from "next";
import { GrowingNova } from "@/components/growing-nova";
import "./growth.css";

export const metadata: Metadata = {
  title: "Growing Nova — Circuit Nova",
  description: "A measurable growth, adoption, revenue, feedback, and valuation control room for Nova.",
};

export default function GrowingNovaPage() {
  return <GrowingNova />;
}
