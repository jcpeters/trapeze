/**
 * trapezeSlackNotify
 *
 * Sends a build status notification to Slack via an Incoming Webhook URL.
 * The webhook URL is read from the 'trapeze-slack-webhook-url' Jenkins credential
 * (set SLACK_TRAPEZE_WEBHOOK_URL in .env to have it seeded automatically by
 * jenkins/init.groovy.d/02-seed-credentials.groovy).
 *
 * Usage (in a Jenkinsfile post block):
 *   trapezeSlackNotify()                            // uses currentBuild.currentResult
 *   trapezeSlackNotify(status: 'FAILURE')
 *   trapezeSlackNotify(status: 'SUCCESS')
 *   trapezeSlackNotify(status: 'SUCCESS', channel: '#my-channel')
 *
 * Gracefully skips (never fails the build) when:
 *   - The 'trapeze-slack-webhook-url' credential does not exist
 *   - The webhook URL is empty / invalid
 *   - curl fails (network issue, bad webhook)
 *
 * Channel default: SLACK_TRAPEZE_CHANNEL env var → '#qa-alerts' fallback.
 * Set SLACK_TRAPEZE_CHANNEL in docker-compose.yml / .env to override.
 */

import groovy.json.JsonOutput

def call(Map args = [:]) {
    def status  = args.status  ?: currentBuild.currentResult
    def channel = args.channel ?: (env.SLACK_TRAPEZE_CHANNEL ?: '#qa-alerts')

    def emojiMap = [SUCCESS: ':white_check_mark:', FAILURE: ':x:', UNSTABLE: ':warning:', ABORTED: ':no_entry_sign:']
    def colorMap = [SUCCESS: 'good',              FAILURE: 'danger',  UNSTABLE: 'warning', ABORTED: '#888888']

    def emoji = emojiMap.get(status, ':grey_question:')
    def color = colorMap.get(status, '#888888')
    def text  = "${emoji} *${env.JOB_NAME}* #${env.BUILD_NUMBER} — ${status}"

    def payload = JsonOutput.toJson([
        channel:     channel,
        text:        text,
        attachments: [[
            color:  color,
            text:   "<${env.BUILD_URL}|View build>",
            footer: "Trapeze CI · ${env.JENKINS_URL ?: 'localhost'}",
        ]],
    ])

    try {
        withCredentials([string(credentialsId: 'trapeze-slack-webhook-url', variable: 'SLACK_WEBHOOK')]) {
            def payloadFile = "${env.WORKSPACE}/.slack-notify-payload.json"
            writeFile file: payloadFile, text: payload
            sh(
                script: "curl -s -X POST \"\$SLACK_WEBHOOK\" -H 'Content-Type: application/json' -d @\"${payloadFile}\" > /dev/null",
                label:  "Slack notify → ${channel} (${status})"
            )
        }
    } catch (Exception e) {
        echo "[trapezeSlackNotify] Skipped (credential missing or webhook error): ${e.message}"
    }
}
