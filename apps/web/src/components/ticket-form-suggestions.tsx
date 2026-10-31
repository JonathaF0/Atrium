"use client";

import { AnnouncementBanner } from "./announcement-banner";
import { KbSuggestions } from "./kb-suggestions";

export interface TicketFormSuggestionsProps {
  subject: string;
  categoryId?: string;
}

/**
 * Shown under the subject on the new-ticket form: active incidents for the
 * chosen category (so clients know it is already being handled) and help
 * articles matching the subject.
 */
export function TicketFormSuggestions({ subject, categoryId }: TicketFormSuggestionsProps): React.ReactElement {
  return (
    <>
      {categoryId && <AnnouncementBanner categoryId={categoryId} />}
      <KbSuggestions subject={subject} categoryId={categoryId} />
    </>
  );
}
