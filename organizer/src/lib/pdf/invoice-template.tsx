import React from "react";
import { Document, Page, StyleSheet, Text, View } from "@react-pdf/renderer";

const styles = StyleSheet.create({
  page: {
    padding: 28,
    backgroundColor: "#FFFFFF",
    fontSize: 10,
    color: "#111827",
  },
  header: {
    marginBottom: 18,
    paddingBottom: 12,
    borderBottom: "1 solid #E5E7EB",
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
  },
  subtitle: {
    marginTop: 6,
    color: "#6B7280",
  },
  infoGrid: {
    marginBottom: 18,
    gap: 6,
  },
  tableHeader: {
    flexDirection: "row",
    paddingVertical: 8,
    borderBottom: "1 solid #D1D5DB",
    backgroundColor: "#F9FAFB",
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 8,
    borderBottom: "1 solid #F3F4F6",
  },
  colName: {
    flex: 2.4,
    paddingRight: 8,
  },
  colQty: {
    flex: 0.8,
    textAlign: "right",
  },
  colPrice: {
    flex: 1.2,
    textAlign: "right",
  },
  totals: {
    marginTop: 18,
    marginLeft: "auto",
    width: 220,
    gap: 6,
  },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  totalValue: {
    fontWeight: 700,
  },
  footer: {
    marginTop: 28,
    paddingTop: 14,
    borderTop: "1 solid #E5E7EB",
    color: "#6B7280",
    lineHeight: 1.5,
  },
});

interface InvoicePDFProps {
  order: {
    orderNumber: string;
    buyerName: string;
    orderedAt: string;
    totalAmount: number;
    paidAmount: number;
    platformFee?: number;
  };
  event: {
    title: string;
  };
  items: Array<{
    productName: string;
    quantity: number;
    unitPrice: number;
    totalAmount: number;
  }>;
}

export function InvoicePDF({ order, event, items }: InvoicePDFProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>주문 확인서</Text>
          <Text style={styles.subtitle}>PICKKET.GO 주문 영수증 및 결제 확인 문서</Text>
        </View>

        <View style={styles.infoGrid}>
          <Text>주문번호: {order.orderNumber}</Text>
          <Text>구매자명: {order.buyerName}</Text>
          <Text>구매일: {order.orderedAt}</Text>
          <Text>이벤트명: {event.title}</Text>
        </View>

        <View style={styles.tableHeader}>
          <Text style={styles.colName}>상품명</Text>
          <Text style={styles.colQty}>수량</Text>
          <Text style={styles.colPrice}>단가</Text>
          <Text style={styles.colPrice}>소계</Text>
        </View>
        {items.map((item) => (
          <View key={`${item.productName}-${item.quantity}-${item.totalAmount}`} style={styles.tableRow}>
            <Text style={styles.colName}>{item.productName}</Text>
            <Text style={styles.colQty}>{item.quantity}</Text>
            <Text style={styles.colPrice}>{item.unitPrice.toLocaleString("ko-KR")}원</Text>
            <Text style={styles.colPrice}>{item.totalAmount.toLocaleString("ko-KR")}원</Text>
          </View>
        ))}

        <View style={styles.totals}>
          <View style={styles.totalRow}>
            <Text>총금액</Text>
            <Text style={styles.totalValue}>{order.totalAmount.toLocaleString("ko-KR")}원</Text>
          </View>
          {(order.platformFee ?? 0) > 0 ? (
            <View style={styles.totalRow}>
              <Text>플랫폼 수수료</Text>
              <Text style={styles.totalValue}>{Number(order.platformFee).toLocaleString("ko-KR")}원</Text>
            </View>
          ) : null}
          <View style={styles.totalRow}>
            <Text>결제금액</Text>
            <Text style={styles.totalValue}>{order.paidAmount.toLocaleString("ko-KR")}원</Text>
          </View>
        </View>

        <Text style={styles.footer}>
          환불 규정은 이벤트별 정책에 따라 다를 수 있으며, 자세한 내용은 이벤트 상세 페이지 또는 고객센터 안내를 확인해주세요.
        </Text>
      </Page>
    </Document>
  );
}
