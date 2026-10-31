import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import * as React from "react";
import { TicketButton, TicketFooter } from "./ticket-parts";

interface TicketStatusEmailProps {
  recipientName: string;
  ticketRef: string;
  subject: string;
  statusLabel: string;
  note?: string;
  ticketUrl: string | null;
  reference: string;
  canReplyByEmail: boolean;
}

/** To the requester: their ticket's status changed (resolved, closed, waiting on them...). */
export function TicketStatusEmail({
  recipientName,
  ticketRef,
  subject,
  statusLabel,
  note,
  ticketUrl,
  reference,
  canReplyByEmail,
}: TicketStatusEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        {ticketRef} is now {statusLabel}
      </Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto" }}>
          <Heading style={{ fontSize: "20px", marginBottom: "16px" }}>
            {ticketRef}: {subject}
          </Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {recipientName ? `${recipientName}, y` : "Y"}our ticket is now <strong>{statusLabel}</strong>.
          </Text>
          {note ? <Text style={{ fontSize: "14px", color: "#374151" }}>{note}</Text> : null}
          {ticketUrl ? <TicketButton href={ticketUrl} label="View ticket" /> : null}
          <TicketFooter reference={reference} replyHint={canReplyByEmail} />
        </Container>
      </Body>
    </Html>
  );
}
