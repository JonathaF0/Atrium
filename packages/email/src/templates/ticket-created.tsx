import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import * as React from "react";
import { TicketBody, TicketButton } from "./ticket-parts";

interface TicketCreatedEmailProps {
  recipientName: string;
  ticketRef: string;
  subject: string;
  requesterName: string;
  priority: string;
  excerpt: string;
  ticketUrl: string;
}

/** To staff: a new ticket was opened. */
export function TicketCreatedEmail({
  recipientName,
  ticketRef,
  subject,
  requesterName,
  priority,
  excerpt,
  ticketUrl,
}: TicketCreatedEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        New ticket {ticketRef}: {subject}
      </Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto" }}>
          <Heading style={{ fontSize: "22px", marginBottom: "16px" }}>New ticket {ticketRef}</Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {recipientName}, {requesterName} opened a ticket: <strong>{subject}</strong>
          </Text>
          <Text style={{ fontSize: "14px", color: "#374151" }}>Priority: {priority}</Text>
          {excerpt ? <TicketBody text={excerpt} /> : null}
          <TicketButton href={ticketUrl} label="Open ticket" />
        </Container>
      </Body>
    </Html>
  );
}
