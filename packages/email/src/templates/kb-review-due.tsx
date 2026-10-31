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

interface ReviewArticle {
  title: string;
  reviewBy: string;
  url: string;
}

interface KbReviewDueEmailProps {
  recipientName?: string | null;
  organizationName: string;
  articles: ReviewArticle[];
  listUrl: string;
}

export function KbReviewDueEmail({
  recipientName,
  organizationName,
  articles,
  listUrl,
}: KbReviewDueEmailProps) {
  const count = articles.length;
  const noun = count === 1 ? "article is" : "articles are";
  return (
    <Html>
      <Head />
      <Preview>
        {String(count)} knowledge base {noun} due for review
      </Preview>
      <Body style={{ fontFamily: "sans-serif", padding: "40px 0" }}>
        <Container style={{ maxWidth: "480px", margin: "0 auto" }}>
          <Heading style={{ fontSize: "24px", marginBottom: "24px" }}>
            Articles due for review
          </Heading>
          <Text style={{ fontSize: "16px", lineHeight: "24px" }}>
            {recipientName ? `Hi ${recipientName}, these` : "These"} {organizationName} knowledge base
            articles you own have passed their review date. Check they are still accurate, then set a
            new review date.
          </Text>
          {articles.map((article) => (
            <Text key={article.url} style={{ fontSize: "15px", lineHeight: "22px", margin: "12px 0" }}>
              <Link href={article.url} style={{ color: "#006b68", fontWeight: 600 }}>
                {article.title}
              </Link>
              <br />
              <span style={{ color: "#6b7280", fontSize: "13px" }}>Review was due {article.reviewBy}</span>
            </Text>
          ))}
          <Text style={{ fontSize: "14px", marginTop: "24px" }}>
            <Link href={listUrl} style={{ color: "#006b68" }}>
              See all articles due for review →
            </Link>
          </Text>
        </Container>
      </Body>
    </Html>
  );
}
