import { Link, Text } from "@react-email/components";
import * as React from "react";

export const ticketButtonStyle: React.CSSProperties = {
  display: "inline-block",
  padding: "12px 24px",
  backgroundColor: "#006b68",
  color: "#ffffff",
  borderRadius: "6px",
  textDecoration: "none",
  fontSize: "16px",
  marginTop: "16px",
};

/** Plain-text message body: line breaks kept, never rendered as HTML. */
export function TicketBody({ text }: { text: string }) {
  return (
    <Text
      style={{
        fontSize: "15px",
        lineHeight: "22px",
        whiteSpace: "pre-wrap",
        backgroundColor: "#f9fafb",
        borderLeft: "3px solid #d1d5db",
        padding: "12px 16px",
      }}
    >
      {text}
    </Text>
  );
}

export function TicketButton({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} style={ticketButtonStyle}>
      {label}
    </Link>
  );
}

/** Footer carrying the ticket reference; replies quoting it are threaded to the ticket. */
export function TicketFooter({ reference, replyHint }: { reference: string; replyHint: boolean }) {
  return (
    <Text style={{ fontSize: "12px", color: "#6b7280", marginTop: "24px" }}>
      {replyHint ? "Reply to this email to add to the ticket. " : ""}
      Ticket reference: {reference}
    </Text>
  );
}
