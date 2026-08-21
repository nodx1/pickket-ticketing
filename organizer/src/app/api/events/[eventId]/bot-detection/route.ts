import { withAuth } from "@/lib/auth/withAuth";
import { getPool } from "@/lib/db/pool";
import { successResponse } from "@/lib/apiResponse";
import { requireFeature } from "@/lib/server/require-feature";

type Params = { eventId: string };

export const GET = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "bot_detection");
  if (featureBlock) return featureBlock;
  const pool = getPool();

  const { rows } = await pool.query(
    `SELECT
       count(*)::int AS "totalOrders",
       count(*) FILTER (WHERE fraud_score > 50)::int AS "flaggedOrders",
       count(*) FILTER (WHERE fraud_score > 80)::int AS "highRiskOrders",
       avg(fraud_score)::int AS "avgFraudScore",
       json_agg(json_build_object(
         'id', id, 'orderNumber', order_number, 'buyerName', buyer_name,
         'buyerEmail', buyer_email, 'fraudScore', fraud_score,
         'fraudFlags', fraud_flags, 'orderedAt', ordered_at
       ) ORDER BY fraud_score DESC) FILTER (WHERE fraud_score > 50) AS "flaggedList"
     FROM orders
     WHERE event_id = $1 AND account_id = $2`,
    [eventId, session.accountId],
  );

  return successResponse(rows[0] ?? { totalOrders: 0, flaggedOrders: 0, highRiskOrders: 0, avgFraudScore: 0, flaggedList: [] });
});
