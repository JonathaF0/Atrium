"use client";

import { ProfileSection } from "../profile/profile-section";
import { TwoFactorSettings } from "@/components/two-factor-settings";

export default function AccountSettingsPage(): React.ReactElement {
  return (
    <div className="space-y-10">
      <ProfileSection />
      <TwoFactorSettings />
    </div>
  );
}
