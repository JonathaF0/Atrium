import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import * as React from "react";
import { TicketBody, TicketButton, TicketFooter } from "./ticket-parts";

interface TicketReplyEmailProps {
  recipientName: string;
  authorName: string;
  ticketRef: string;
  subject: string;
  body: string;
  ticketUrl: string | null;
  reference: string;
  canReplyByEmail: boolean;
}

/** To the requester: a staff member replied. `body` is plain text derived from the public reply. */
export function TicketReplyEmail({
  recipientName,
  authorName,
  ticketRef,
  subject,
  body,
  ticketUrl,
  reference,
  canReplyByEmail,
}: TicketReplyEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        {authorName} replied to {ticketRef}
      </Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto" }}>
          <Heading style={{ fontSize: "20px", marginBottom: "16px" }}>
            {ticketRef}: {subject}
          </Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {recipientName ? `${recipientName}, ` : ""}
            {authorName} replied to your ticket:
          </Text>
          <TicketBody text={body} />
          {ticketUrl ? <TicketButton href={ticketUrl} label="View ticket" /> : null}
          <TicketFooter reference={reference} replyHint={canReplyByEmail} />
        </Container>
      </Body>
    </Html>
  );
}
