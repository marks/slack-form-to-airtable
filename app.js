// Load validated Config object from config.js (which uses dotenv to read from the local .env file)
const { Config } = require('./config')

// Load Bolt app, a Slack application framework which wraps Express
const { App } = require('@slack/bolt')

// Load Airtable.js, a wrapper for the Airtable API
const Airtable = require('airtable')

// Load helper functions
const modalBlocks = require('./views/modals')
const messageBlocks = require('./views/messages')
const appHomeBlocks = require('./views/app_home')

/*
This sample slack application uses SocketMode
For the companion getting started setup guide,
see: https://slack.dev/bolt-js/tutorial/getting-started
*/

// Initializes your app with your bot token and app token
const app = new App({
  socketMode: true,
  token: Config.SLACK_BOT_TOKEN,
  appToken: Config.SLACK_APP_TOKEN,
  logLevel: Config.LOG_LEVEL || 'debug'
})

// Initialize Airtable client
const airtableClient = new Airtable({ apiKey: Config.AIRTABLE_API_KEY })
const airtableBase = airtableClient.base(Config.AIRTABLE_BASE_ID)
const airtableTable = airtableBase(Config.AIRTABLE_TABLE_ID)

// Listen for 'File a bug' global shortcut
app.shortcut('fileABugGlobalShortcut', async ({ shortcut, ack, client }) => {
  // Acknowledge shortcut request
  await ack()

  // Open modal using WebClient passed in from middleware.
  //   Uses modal defintion from views/modals.js
  await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: modalBlocks.newBug()
  })
})

// Listen for 'File a bug' message shortcut
app.shortcut('fileABugMessageShortcut', async ({ ack, shortcut, client }) => {
  await ack()

  // Open modal using WebClient passed in from middleware.
  //   Uses modal defintion from views/modals.js
  await client.views.open({
    trigger_id: shortcut.trigger_id,
    view: modalBlocks.newBug({ description: shortcut.message.text })
  })
})

// Listen for form/modal submission
app.view('create_bug', async ({ ack, body, view, client, logger }) => {
  // Extract user-submitted values from view submission object
  const {
    block_title: { input_title: { value: title } },
    block_priority: { input_priority: { selected_option: { value: priority } } },
    block_description: { input_description: { value: description } }
  } = view.state.values
  logger.debug('User submitted values: ', { title, priority, description })

  // Validate inputs
  const errors = {}
  if (description.length < 10) {
    errors.block_description = 'Description must be at least 10 characters'
  }

  // If there are errors, respond to Slack with errors; otherwise, respond with a confirmation
  if (Object.keys(errors).length > 0) {
    console.warn('errors: ', errors)
    await ack({
      response_action: 'errors',
      errors
    })
  } else {
    // If there are no errors, close the modal and DM the user a confirmation
    await ack()

    const dmToSubmitter = await client.chat.postMessage({
      channel: body.user.id,
      text: 'Thanks for your bug report! We will triage it ASAP.',
      blocks: messageBlocks.initialMessageToSubmitter(title, priority)
    })

    // Thread full description to DM thread (in case submission fails, user has a backup of what they submitted)
    await client.chat.postMessage({
      channel: dmToSubmitter.channel,
      thread_ts: dmToSubmitter.ts,
      text: '*Description:* \n> ' + description.split('\n').join('\n> ')
    })

    // Create object to be inserted into Airtable table
    const newRecordFields = {
      'Short description': title,
      'Long description': description,
      Priority: priority,
      'Submitter Slack UID': body.user.id,
      'Submitter Slack Name': body.user.name
    }

    // Depending on success/failure from Airtable API, update DM to submitter
    let updateToSubmitter = ''
    try {
      const newRecord = await airtableTable.create([{ fields: newRecordFields }])
      const newRecordId = newRecord[0].getId()
      updateToSubmitter = messageBlocks.successfullySavedToAirtable(Config.AIRTABLE_BASE_ID, Config.AIRTABLE_TABLE_ID, newRecordId)
    } catch (error) {
      updateToSubmitter = messageBlocks.simpleMessage(`:bangbang: Sorry, but an error occured while sending your record details to Airtable. \nError details: \`\`\`${JSON.stringify(error, null, 2)} \`\`\``)
    }

    // Thread update to DM thread
    await client.chat.postMessage({
      channel: dmToSubmitter.channel,
      thread_ts: dmToSubmitter.ts,
      blocks: updateToSubmitter,
      unfurl_links: false,
      reply_broadcast: true // send threaded reply to channel
    })
  }
})

// Listen for users opening App Home
app.event('app_home_opened', async ({ event, client }) => {
  // Publish App Home view
  await client.views.publish({
    user_id: event.user,
    view: {
      type: 'home',
      blocks: appHomeBlocks(Config.AIRTABLE_BASE_ID, Config.AIRTABLE_TABLE_ID)
    }
  })
})

// Listen for users clicking the 'File a bug' button from App Home
app.action('file_a_bug', async ({ ack, body, client }) => {
  await ack()

  // Open modal using WebClient passed in from middleware.
  //   Uses modal defintion from views/modals.js
  await client.views.open({
    trigger_id: body.trigger_id,
    view: modalBlocks.newBug()
  })
})

// Listen for users clicking a button that opens a URL
//   Without this, Slack will show a /!\ warning icon next to buttons
app.action('url_button', async ({ ack }) => {
  await ack()
})

// Listen for users clicking the 'Delete' button from their DMs
app.action('delete_record', async ({ ack, action, respond, body, logger }) => {
  await ack()
  const recordId = action.value

  // Attempt to delete record from Airtable
  let blocks = []
  try {
    const recordBeforeDeletion = await airtableTable.find(recordId)
    await recordBeforeDeletion.destroy()
    logger.debug({ recordBeforeDeletion })
    blocks = messageBlocks.simpleMessage(`Record \`${recordBeforeDeletion.get(Config.AIRTABLE_PRIMARY_FIELD_NAME)}\` (${recordId}) was successfully deleted. \n\nYou can recover deleted records from your <https://support.airtable.com/hc/en-us/articles/115014104628-Base-trash|base trash> for a limited amount of time.`)
  } catch (error) {
    blocks = messageBlocks.simpleMessage(`<@${body.user.id}> There was an error deleting this record (it may have been already deleted by someone else): \`\`\`${JSON.stringify(error, null, 2)} \`\`\``)
  }

  // Respond by deleting the original message and adding a new message to the thread
  await respond({
    blocks,
    replace_original: false,
    delete_original: true,
    response_type: 'in_channel',
    thread_ts: body.message.thread_ts
  })
})

// Listen for users clicking the 'Edit' button from their DMs
app.action('edit_record', async ({ ack, action, client, body }) => {
  await ack()

  // Retrieve latest record values from Airtable
  const recordId = action.value
  const recordBeforeEditing = await airtableTable.find(recordId)

  // Open modal and prefill values
  await client.views.open({
    trigger_id: body.trigger_id,
    view: modalBlocks.updateBug({
      title: recordBeforeEditing.get('Short description'),
      description: recordBeforeEditing.get('Long description'),
      priority: recordBeforeEditing.get('Priority'),
      recordId
    })
  })
});

(async () => {
  // Test connection to Airtable before starting Bolt
  try {
    await airtableTable.select({ maxRecords: 1 }).all()
    app.client.logger.info('✅  Connected to Airtable')
  } catch (error) {
    app.client.logger.error('❌  Bolt NOT started; there was an error connecting to Airtable: ', error)
    process.exit(1)
  }

  // Start Bolt app
  await app.start()
  app.client.logger.info('✅  Slack Bolt app is running!')
})()
