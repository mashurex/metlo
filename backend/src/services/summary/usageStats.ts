import { UsageStats } from "@common/types"
import {
  AggregateTraceDataHourly,
  Alert,
  ApiEndpoint,
  ApiTrace,
  DataField,
} from "models"
import { DatabaseService } from "services/database"
import { MetloContext } from "types"
import { RedisClient } from "utils/redis"

export const getUsageStats = async (ctx: MetloContext) => {
  const statsQuery = `
    SELECT
      DATE_TRUNC('day', traces.hour) as day,
      SUM(traces."numCalls") as cnt
    FROM ${AggregateTraceDataHourly.getTableName(ctx)} traces
    WHERE traces.hour > (NOW() - INTERVAL '15 days')
    GROUP BY 1
    ORDER BY 1
  `
  const lastNRequestsQuery = `
    SELECT
      CAST(SUM(CASE WHEN traces."createdAt" > (NOW() - INTERVAL '1 minutes') THEN 1 ELSE 0 END) AS INTEGER) as "last1MinCnt",
      CAST(COUNT(*) AS INTEGER) as "last60MinCnt"
    FROM ${ApiTrace.getTableName(ctx)} traces
    WHERE traces."createdAt" > (NOW() - INTERVAL '60 minutes')
  `
  const queryResponses = await DatabaseService.executeRawQueries([
    statsQuery,
    lastNRequestsQuery,
  ])
  const stats: {
    day: string
    cnt: number
  }[] = queryResponses[0]
  const lastNRequests: {
    last1MinCnt: number
    last60MinCnt: number
  } = queryResponses[1]
  return {
    dailyUsage: stats,
    last1MinCnt: lastNRequests[0].last1MinCnt,
    last60MinCnt: lastNRequests[0].last60MinCnt,
  } as UsageStats
}

export const getUsageStatsCached = async (ctx: MetloContext) => {
  const cacheRes: UsageStats | null = await RedisClient.getFromRedis(
    ctx,
    "usageStats",
  )
  if (cacheRes) {
    return cacheRes
  }
  const realRes = await getUsageStats(ctx)
  await RedisClient.addToRedis(ctx, "usageStats", realRes, 60)
  return realRes
}

interface CountsResponse {
  newAlerts: number
  endpointsTracked: number
  piiDataFields: number
  hostCount: number
  highRiskAlerts: number
}

export const getCounts = async (ctx: MetloContext) => {
  const newAlertQuery = `
    SELECT
      CAST(COUNT(*) AS INTEGER) as count,
      CAST(SUM(CASE WHEN "riskScore" = 'high' THEN 1 ELSE 0 END) AS INTEGER) as high_risk_count
    FROM ${Alert.getTableName(ctx)} alert WHERE status = 'Open'
  `
  const endpointsTrackedQuery = `
    SELECT
      CAST(COUNT(*) AS INTEGER) as endpoint_count,
      CAST(COUNT(DISTINCT(host)) AS INTEGER) as host_count
    FROM ${ApiEndpoint.getTableName(ctx)} api_endpoint
  `
  const piiDataFieldsQuery = `
    SELECT CAST(COUNT(*) AS INTEGER) as count
    FROM ${DataField.getTableName(ctx)} data_field WHERE "dataTag" = 'PII'
  `
  const [newAlertQueryRes, endpointsTrackedQueryRes, piiDataFieldsQueryRes] =
    await DatabaseService.executeRawQueries([
      newAlertQuery,
      endpointsTrackedQuery,
      piiDataFieldsQuery,
    ])
  const newAlerts = newAlertQueryRes[0].count ?? 0
  const highRiskAlerts = newAlertQueryRes[0].high_risk_count ?? 0
  const endpointsTracked = endpointsTrackedQueryRes[0].endpoint_count ?? 0
  const hostCount = endpointsTrackedQueryRes[0].host_count ?? 0
  const piiDataFields = piiDataFieldsQueryRes[0].count ?? 0
  return {
    newAlerts,
    endpointsTracked,
    piiDataFields,
    hostCount,
    highRiskAlerts,
  }
}

export const getCountsCached = async (ctx: MetloContext) => {
  const cacheRes: CountsResponse | null = await RedisClient.getFromRedis(
    ctx,
    "usageCounts",
  )
  if (cacheRes) {
    return cacheRes
  }
  const realRes = await getCounts(ctx)
  await RedisClient.addToRedis(ctx, "usageCounts", realRes, 60)
  return realRes
}
