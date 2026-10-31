"use client";

export interface TicketFormSuggestionsProps {
  subject: string;
  categoryId?: string;
}

/**
 * Slot under the subject field for suggested help articles ("deflection").
 * Renders nothing until the knowledge base provides suggestions.
 */
export function TicketFormSuggestions(_props: TicketFormSuggestionsProps): React.ReactElement | null {
  return null;
}
