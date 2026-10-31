"use client";

import { TaxRatesSection } from "./tax-rates-section";

export default function EstimateSettingsPage(): React.ReactElement {
  return (
    <div className="divide-y divide-[var(--border)] space-y-0">
      <section className="pb-10">
        <TaxRatesSection />
      </section>
    </div>
  );
}
