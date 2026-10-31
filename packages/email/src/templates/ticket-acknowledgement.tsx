import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import * as React from "react";
import { TicketButton, TicketFooter } from "./ticket-parts";

interface TicketAcknowledgementEmailProps {
  recipientName: string;
  workspaceName: string;
  ticketRef: string;
  subject: string;
  ticketUrl: string | null;
  reference: string;
  canReplyByEmail: boolean;
}

/** Automatic receipt for a ticket opened from the portal or by email. */
export function TicketAcknowledgementEmail({
  recipientName,
  workspaceName,
  ticketRef,
  subject,
  ticketUrl,
  reference,
  canReplyByEmail,
}: TicketAcknowledgementEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>We received your request {ticketRef}</Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto" }}>
          <Heading style={{ fontSize: "20px", marginBottom: "16px" }}>We received your request</Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {recipientName ? `${recipientName}, t` : "T"}hanks for contacting {workspaceName}. Your request{" "}
            <strong>{subject}</strong> has been logged as {ticketRef} and our team will get back to you.
          </Text>
          {ticketUrl ? <TicketButton href={ticketUrl} label="View ticket" /> : null}
          <TicketFooter reference={reference} replyHint={canReplyByEmail} />
        </Container>
      </Body>
    </Html>
  );
}
