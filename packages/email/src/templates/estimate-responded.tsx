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

interface EstimateRespondedEmailProps {
  recipientName: string;
  clientName: string;
  estimateNumber: string;
  title: string;
  /** "accepted" | "declined" | "changes_requested" */
  action: string;
  /** Decline reason or change request, plain text. */
  message: string | null;
  dashboardUrl: string;
}

const VERBS: Record<string, string> = {
  accepted: "accepted",
  declined: "declined",
  changes_requested: "requested changes to",
};

export function EstimateRespondedEmail({
  recipientName,
  clientName,
  estimateNumber,
  title,
  action,
  message,
  dashboardUrl,
}: EstimateRespondedEmailProps) {
  const verb = VERBS[action] ?? action;
  return (
    <Html>
      <Head />
      <Preview>
        {clientName} {verb} estimate {estimateNumber}
      </Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "480px", margin: "0 auto" }}>
          <Heading style={{ fontSize: "24px", marginBottom: "24px" }}>
            Estimate {estimateNumber} {action === "changes_requested" ? "needs changes" : verb}
          </Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {recipientName}, {clientName} {verb} the estimate &quot;{title}&quot;.
          </Text>
          {message && (
            <Text
              style={{
                fontSize: "15px",
                lineHeight: "22px",
                padding: "12px 16px",
                backgroundColor: "#f3f4f6",
                borderRadius: "6px",
                whiteSpace: "pre-wrap",
              }}
            >
              {message}
            </Text>
          )}
          <Link
            href={dashboardUrl}
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
            Open Estimate
          </Link>
        </Container>
      </Body>
    </Html>
  );
}
