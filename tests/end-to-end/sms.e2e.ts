import { waitForReact } from 'testcafe-react-selectors'
import {
  CampaignsPage,
  CreateModalPage,
  LandingPage,
  LoginPage,
  SmsCampaignPage,
  ProgressDetailsPage,
} from './page-models'
import { MockMailServer, MockTwilioServer } from './../mocks'
import { getPageUrl, generateRandomEmail } from './helpers'
import config from './../config'

fixture`SMS campaigns`
  .page(config.get('frontendUrl'))
  .beforeEach(async (t) => {
    const email = generateRandomEmail()
    t.ctx.email = email
    t.ctx.credentials = {
      accountSid: 'ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      apiKey: 'SKXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
      apiSecret: 'thisisdummysecretfortwiliocredentials',
      messagingServiceSid: 'MGXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    }

    await waitForReact()
    await LandingPage.selectLogin()
    await LoginPage.login(email)

    // Check to ensure we've logged in
    await t.expect(getPageUrl()).contains('/campaigns')
  })
  .afterEach(async () => {
    await MockMailServer.deleteAll()
    MockTwilioServer.deleteAll()
  })

test('Create SMS campaign', async (t) => {
  const { credentials } = t.ctx
  await CampaignsPage.selectCreateCampaign()
  await CreateModalPage.createCampaign('sms', 'SMS')

  await SmsCampaignPage.createTemplate({
    body: 'This is a test message',
  })
  await SmsCampaignPage.uploadRecipient({
    filename: './../files/sms.csv',
  })
  await SmsCampaignPage.enterAndValidateNewCredentials({
    ...credentials,
    phoneNumber: '91234567',
  })
  await SmsCampaignPage.sendCampaign()
  await ProgressDetailsPage.checkStatistics({
    error: 2,
    sent: 4,
    invalid: 0,
  })

  const latestMessage = MockTwilioServer.getLastestMessage('+6591234567')
  await t.expect(latestMessage.body).eql('This is a test message')
})