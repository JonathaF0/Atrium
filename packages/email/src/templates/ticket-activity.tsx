import { Body, Container, Head, Heading, Html, Preview, Text } from "@react-email/components";
import * as React from "react";
import { TicketBody, TicketButton } from "./ticket-parts";

interface TicketActivityEmailProps {
  recipientName: string;
  /** e.g. "TKT-1042 was closed by the client" */
  heading: string;
  /** One sentence on what happened. */
  message: string;
  /** Quoted text: a reply, a rating comment. */
  excerpt?: string;
  ticketUrl: string;
}

/** To staff: something happened on a ticket (client closed, reopened, replied, rated; assigned; SLA breached). */
export function TicketActivityEmail({ recipientName, heading, message, excerpt, ticketUrl }: TicketActivityEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{heading}</Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "560px", margin: "0 auto" }}>
          <Heading style={{ fontSize: "22px", marginBottom: "16px" }}>{heading}</Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {recipientName ? `${recipientName}, ` : ""}
            {message}
          </Text>
          {excerpt ? <TicketBody text={excerpt} /> : null}
          <TicketButton href={ticketUrl} label="Open ticket" />
        </Container>
      </Body>
    </Html>
  );
}
