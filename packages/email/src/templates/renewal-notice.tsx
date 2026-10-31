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

interface RenewalNoticeItem {
  title: string;
  /** e.g. "Sample Company · warranty ends Nov 30, 2026" */
  detail: string;
  url: string;
}

interface RenewalNoticeEmailProps {
  organizationName: string;
  heading: string;
  intro: string;
  items: RenewalNoticeItem[];
  moreCount?: number;
  listUrl: string;
  listLabel: string;
}

/** Digest of upcoming renewals (asset warranties and licenses, service contracts) for owners and admins. */
export function RenewalNoticeEmail({
  organizationName,
  heading,
  intro,
  items,
  moreCount = 0,
  listUrl,
  listLabel,
}: RenewalNoticeEmailProps) {
  return (
    <Html>
      <Head />
      <Preview>{heading}</Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "520px", margin: "0 auto" }}>
          <Heading style={{ fontSize: "24px", marginBottom: "24px" }}>{heading}</Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>{intro}</Text>
          {items.map((item) => (
            <Text key={item.url + item.title} style={{ fontSize: "15px", lineHeight: "22px", margin: "12px 0" }}>
              <Link href={item.url} style={{ color: "#006b68", fontWeight: 600 }}>
                {item.title}
              </Link>
              <br />
              <span style={{ color: "#6b7280", fontSize: "13px" }}>{item.detail}</span>
            </Text>
          ))}
          {moreCount > 0 && (
            <Text style={{ fontSize: "14px", color: "#6b7280" }}>and {String(moreCount)} more</Text>
          )}
          <Link
            href={listUrl}
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
            {listLabel}
          </Link>
          <Text style={{ fontSize: "13px", color: "#6b7280", marginTop: "32px" }}>
            You receive this because you are an owner or admin of {organizationName}.
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
