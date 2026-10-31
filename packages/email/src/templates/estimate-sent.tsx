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

interface EstimateSentEmailProps {
  clientName: string;
  orgName: string;
  estimateNumber: string;
  title: string;
  amount: string;
  validUntil: string | null;
  portalUrl: string;
  /** "sent" for a new estimate or revision, "reminder" shortly before it expires. */
  kind: "sent" | "reminder";
}

export function EstimateSentEmail({
  clientName,
  orgName,
  estimateNumber,
  title,
  amount,
  validUntil,
  portalUrl,
  kind,
}: EstimateSentEmailProps) {
  const heading = kind === "reminder" ? `Estimate ${estimateNumber} expires soon` : `Estimate ${estimateNumber}`;
  return (
    <Html>
      <Head />
      <Preview>
        {kind === "reminder" ? `Reminder: ${title} expires soon` : `${orgName} sent you an estimate: ${title}`}
      </Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "480px", margin: "0 auto" }}>
          <Heading style={{ fontSize: "24px", marginBottom: "24px" }}>{heading}</Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {kind === "reminder"
              ? `${clientName}, the estimate "${title}" from ${orgName} (${amount}) is still waiting for your response.`
              : `${clientName}, ${orgName} sent you the estimate "${title}" for ${amount}.`}
          </Text>
          {validUntil && (
            <Text style={{ fontSize: "16px", lineHeight: "24px" }}>It is valid until {validUntil}.</Text>
          )}
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            You can review it, choose optional items, request changes, or accept it online.
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
            Review Estimate
          </Link>
          <Text style={{ fontSize: "14px", color: "#6b7280", marginTop: "24px" }}>
            You are receiving this email because an estimate was addressed to you.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
