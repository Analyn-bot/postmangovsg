import { fn, cast, Transaction, Op, literal } from 'sequelize'
import { Statistic, JobQueue, Campaign } from '@core/models'
import {
  CampaignStats,
  CampaignStatsCount,
  CampaignRecipient,
} from '@core/interfaces'
import { MessageStatus, JobStatus } from '@core/constants'

/**
 * Helper method to get precomputed number of errored , sent, and unsent from statistic table.
 * @param campaignId
 */
const getStatsFromArchive = async (
  campaignId: number
): Promise<CampaignStatsCount> => {
  const stats = await Statistic.findByPk(campaignId)
  if (!stats) {
    return {
      error: 0,
      sent: 0,
      unsent: 0,
      invalid: 0,
      updated_at: new Date(),
    }
  }
  return {
    error: stats?.errored,
    sent: stats?.sent,
    unsent: stats?.unsent,
    invalid: stats?.invalid,
    updated_at: stats?.updatedAt,
  }
}

/**
 * Return total count from statistic table
 * @param campaignId
 */
const getNumRecipients = async (campaignId: number): Promise<number> => {
  const { error, unsent, sent, invalid } = await getStatsFromArchive(campaignId)
  return error + unsent + sent + invalid
}

/**
 * Upsert unsent count to statistic table
 * @param campaignId
 * @param unsent
 * @param transaction optional
 */
const setNumRecipients = async (
  campaignId: number,
  unsent: number,
  transaction?: Transaction
): Promise<void> => {
  await Statistic.upsert(
    {
      campaignId,
      unsent,
      errored: 0,
      sent: 0,
      invalid: 0,
    },
    {
      transaction,
    }
  )
}

/**
 * Helper method to get the count of errored messages, sent messages, and messages that remain unsent from ops table.
 * @param campaignId
 * @param model
 */
const getStatsFromTable = async (
  campaignId: number,
  model: any
): Promise<CampaignStatsCount> => {
  // Retrieve stats from ops table
  const [data] = await model.findAll({
    raw: true,
    where: { campaignId },
    attributes: [
      [fn('sum', cast({ status: MessageStatus.Error }, 'int')), 'error'],
      [fn('sum', cast({ status: MessageStatus.Sending }, 'int')), 'sent'],
      [fn('sum', cast({ status: null }, 'int')), 'unsent'],
      [
        fn('sum', cast({ status: MessageStatus.InvalidRecipient }, 'int')),
        'invalid',
      ],
    ],
  })

  return {
    error: +data.error,
    sent: +data.sent,
    unsent: +data.unsent,
    invalid: +data.invalid,
    updated_at: new Date(),
  }
}

/**
 * Helper method to get current count of errored , sent, and unsent depending on job status
 * @param campaignId
 * @param opsTable
 */
const getCurrentStats = async (
  campaignId: number,
  opsTable: any
): Promise<CampaignStats> => {
  // Get job from job_queue table
  const job = await JobQueue.findOne({
    where: { campaignId },
    include: [
      {
        model: Campaign,
        attributes: ['halted', ['cred_name', 'credName']],
      },
    ],
  })

  if (job === null)
    throw new Error('Unable to find campaign in job queue table.')

  // Get stats from statistics table
  const archivedStats = await getStatsFromArchive(campaignId)

  // If job is sending, sent or stopped, i.e. not logged back to message table,
  // Retrieve current stats from ops table
  const { Sending, Sent, Stopped } = JobStatus
  if ([Sending, Sent, Stopped].includes(job.status)) {
    const opsStats = await getStatsFromTable(campaignId, opsTable)

    // Sent count must be added to archived sent count since sent messages are
    // not enqueued to ops table if a project is stopped and resumed
    // Since sent and invalid are not retried, they have to be added to archived stats
    return {
      error: opsStats.error,
      unsent: opsStats.unsent,
      sent: opsStats.sent + archivedStats.sent,
      // this is needed when invalid might appear in ops table, e.g. telegram immediate bounce errors
      invalid: opsStats.invalid + archivedStats.invalid,
      status: job.status,
      updated_at: job.updatedAt,
      halted: job.campaign.halted,
    }
  }

  const stats = {
    ...archivedStats,
    status: job.status,
    halted: job.campaign.halted,
    status_updated_at: job.updatedAt, // Timestamp when job was logged
  }

  // If job is not in send queue, return archived stats
  if (job.status !== JobStatus.Ready) {
    return stats
  }

  if (!job.campaign.credName) {
    throw new Error('Missing credential for campaign')
  }
  // get send time of all campaigns using this credential that are queued before this campaign
  const data = await JobQueue.findAll({
    where: {
      id: { [Op.lt]: job.id },
      status: {
        [Op.or]: [JobStatus.Enqueued, JobStatus.Ready, JobStatus.Sending],
      },
    },
    include: [
      {
        model: Campaign,
        where: { credName: job.campaign.credName },
        include: [Statistic],
      },
    ],
    attributes: [[literal('unsent / send_rate'), 'wait_time']],
    raw: true,
  })

  const totalWaitTime = data.reduce((time: number, job: any) => {
    const { wait_time: waitTime } = job
    return time + waitTime
  }, 0)

  return {
    ...stats,
    wait_time: totalWaitTime,
  }
}

/*
 * Get total sent messages across all channels
 */
const getTotalSentCount = async (): Promise<number> => {
  return Statistic.sum('sent')
}

/**
 * Helper method to get delivered messages from logs table
 * @param campaignId
 * @param logsTable
 */
const getDeliveredRecipients = async (
  campaignId: number,
  logsTable: any
): Promise<Array<CampaignRecipient>> => {
  const data = await logsTable.findAll({
    raw: true,
    where: {
      campaignId,
      status: {
        [Op.ne]: null,
      },
    },
    attributes: ['recipient', 'status', 'error_code', 'updated_at'],
    useMaster: false,
  })

  return data
}

export const StatsService = {
  getCurrentStats,
  getTotalSentCount,
  getNumRecipients,
  setNumRecipients,
  getDeliveredRecipients,
}
