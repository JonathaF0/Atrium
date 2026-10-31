import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Text,
} from "@react-email/components";
import * as React from "react";

interface InvoiceReminderEmailProps {
  clientName: string;
  invoiceNumber: string;
  amount: string;
  dueDate: string;
  daysOverdue: number;
  /** 1 for the first reminder, 2 for the second, and so on. */
  reminderNumber: number;
  portalUrl: string;
}

export function InvoiceReminderEmail({
  clientName,
  invoiceNumber,
  amount,
  dueDate,
  daysOverdue,
  reminderNumber,
  portalUrl,
}: InvoiceReminderEmailProps) {
  const dayWord = daysOverdue === 1 ? "day" : "days";
  return (
    <Html>
      <Head />
      <Preview>
        Reminder: invoice {invoiceNumber} is {String(daysOverdue)} {dayWord} overdue
      </Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "480px", margin: "0 auto" }}>
          <Heading style={{ fontSize: "24px", marginBottom: "24px" }}>
            {reminderNumber > 1 ? "Second notice: " : ""}Invoice {invoiceNumber} is overdue
          </Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {clientName}, invoice {invoiceNumber} for {amount} was due {dueDate} and
            is now {daysOverdue} {dayWord} overdue. If you have already paid, thank
            you and please disregard this reminder.
          </Text>
          <Link
            href={portalUrl}
            style={{
              display: "inline-block",
              padding: "12px 24px",
              backgroundColor: "#006b68",
              color: "#ffffff",
              borderRadius: "6px",
              textDecoration: "none",
              fontSize: "16px",
              marginTop: "16px",
            }}
          >
            View Invoice
          </Link>
          <Text
            style={{ fontSize: "14px", color: "#6b7280", marginTop: "24px" }}
          >
            You are receiving this email because this invoice is addressed to you.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
