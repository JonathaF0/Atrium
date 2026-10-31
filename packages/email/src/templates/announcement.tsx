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

interface AnnouncementEmailProps {
  recipientName: string;
  orgName: string;
  /** "published" for a new announcement, "update" for an incident update, "reminder" before maintenance. */
  kind: "published" | "update" | "reminder";
  /** Human label, e.g. "Scheduled maintenance" or "Service incident". */
  typeLabel: string;
  title: string;
  /** Plain text; markdown is flattened by the sender. */
  summary: string;
  /** Latest incident update, plain text. */
  latestUpdate?: string;
  /** Status label for incident updates, e.g. "Monitoring". */
  stateLabel?: string;
  /** Maintenance window, already formatted. */
  windowText?: string;
  impact?: string;
  portalUrl: string;
}

const HEADINGS: Record<AnnouncementEmailProps["kind"], string> = {
  published: "New announcement",
  update: "Incident update",
  reminder: "Upcoming maintenance",
};

export function AnnouncementEmail({
  recipientName,
  orgName,
  kind,
  typeLabel,
  title,
  summary,
  latestUpdate,
  stateLabel,
  windowText,
  impact,
  portalUrl,
}: AnnouncementEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>
        {typeLabel}: {title}
      </Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "480px", margin: "0 auto" }}>
          <Text style={{ fontSize: "12px", color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {typeLabel}
          </Text>
          <Heading style={{ fontSize: "24px", marginBottom: "16px" }}>{title}</Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {recipientName ? `${recipientName}, ` : ""}
            {kind === "reminder"
              ? `this is a reminder about upcoming maintenance from ${orgName}.`
              : kind === "update"
                ? `${orgName} posted an update${stateLabel ? ` (${stateLabel})` : ""}.`
                : `${orgName} posted a new ${HEADINGS[kind].toLowerCase()}.`}
          </Text>
          {windowText && (
            <Text style={{ fontSize: "14px", lineHeight: "22px" }}>
              <strong>When:</strong> {windowText}
            </Text>
          )}
          {impact && (
            <Text style={{ fontSize: "14px", lineHeight: "22px" }}>
              <strong>Impact:</strong> {impact}
            </Text>
          )}
          {latestUpdate && (
            <Text
              style={{
                fontSize: "14px",
                lineHeight: "22px",
                color: "#374151",
                backgroundColor: "#f9fafb",
                padding: "12px 16px",
                borderRadius: "6px",
                borderLeft: "3px solid #006b68",
              }}
            >
              {latestUpdate}
            </Text>
          )}
          <Text style={{ fontSize: "14px", lineHeight: "22px", color: "#374151" }}>{summary}</Text>
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
            View in portal
          </Link>
          <Text style={{ fontSize: "14px", color: "#6b7280", marginTop: "24px" }}>
            You are receiving this email because you have access to the {orgName} client portal.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
