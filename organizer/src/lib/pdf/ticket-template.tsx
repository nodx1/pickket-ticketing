import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

const styles = StyleSheet.create({
  page: {
    padding: 24,
    backgroundColor: "#F8FAFC",
    fontSize: 11,
    color: "#111827",
  },
  ticket: {
    minHeight: "50%",
    borderRadius: 18,
    overflow: "hidden",
    border: "1 solid #D7DBE7",
    backgroundColor: "#FFFFFF",
  },
  header: {
    padding: 20,
    backgroundColor: "#6C5CE7",
  },
  headerEyebrow: {
    fontSize: 10,
    color: "#E9E5FF",
    textTransform: "uppercase",
  },
  headerTitle: {
    marginTop: 8,
    fontSize: 22,
    fontWeight: 700,
    color: "#FFFFFF",
  },
  body: {
    padding: 20,
    gap: 14,
  },
  section: {
    gap: 6,
  },
  label: {
    fontSize: 9,
    color: "#6B7280",
    textTransform: "uppercase",
  },
  value: {
    fontSize: 13,
    fontWeight: 700,
    color: "#111827",
  },
  qrBox: {
    marginTop: 6,
    borderRadius: 14,
    border: "1 dashed #C7D2FE",
    backgroundColor: "#F5F3FF",
    padding: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  qrTitle: {
    fontSize: 10,
    color: "#6C5CE7",
  },
  qrCode: {
    marginTop: 10,
    fontSize: 16,
    fontWeight: 700,
    letterSpacing: 1,
    color: "#111827",
  },
});

interface TicketPDFProps {
  eventName: string;
  eventDate: string;
  venueName: string;
  attendeeName: string;
  ticketNumber: string;
  orderNumber: string;
  // 트랙 7.6 — 좌석 정보 (옵션, 좌석 지정 이벤트만)
  seatInfo?: {
    section: string;
    row: string;
    seatNumber: string;
    floorLabel?: string | null;
    tierName?: string | null;
  } | null;
}

export function TicketPDF({
  eventName,
  eventDate,
  venueName,
  attendeeName,
  ticketNumber,
  orderNumber,
  seatInfo,
}: TicketPDFProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.ticket}>
          <View style={styles.header}>
            <Text style={styles.headerEyebrow}>pickket.go mobile ticket</Text>
            <Text style={styles.headerTitle}>{eventName}</Text>
          </View>

          <View style={styles.body}>
            <View style={styles.section}>
              <Text style={styles.label}>일정</Text>
              <Text style={styles.value}>{eventDate}</Text>
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>장소</Text>
              <Text style={styles.value}>{venueName}</Text>
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>참석자</Text>
              <Text style={styles.value}>{attendeeName}</Text>
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>주문번호</Text>
              <Text style={styles.value}>{orderNumber}</Text>
            </View>

            {seatInfo ? (
              <View style={styles.section}>
                <Text style={styles.label}>좌석</Text>
                <Text style={styles.value}>
                  {seatInfo.floorLabel ? `${seatInfo.floorLabel} ` : ""}
                  {seatInfo.section}섹션 {seatInfo.row}열 {seatInfo.seatNumber}번
                  {seatInfo.tierName ? ` · ${seatInfo.tierName}` : ""}
                </Text>
              </View>
            ) : null}

            <View style={styles.qrBox}>
              <Text style={styles.qrTitle}>QR 코드 영역</Text>
              <Text style={styles.qrCode}>{ticketNumber}</Text>
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}
