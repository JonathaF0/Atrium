"use client";

import { EstimateSettingsSection } from "./estimate-settings-section";
import { TaxRatesSection } from "./tax-rates-section";

export default function EstimateSettingsPage(): React.ReactElement {
  return (
    <div className="divide-y divide-[var(--border)] space-y-0">
      <section className="pb-10">
        <EstimateSettingsSection />
      </section>
      <section className="pt-10">
        <TaxRatesSection />
      </section>
    </div>
  );
}
