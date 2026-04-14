#!/usr/bin/env bash
# jenkins-seed-prod.sh
#
# Seeds all Trapeze credentials and creates all 5 pipeline jobs on a
# production Jenkins instance via the Jenkins Script Console REST API.
# No UI clicks required.
#
# ── Prerequisites ─────────────────────────────────────────────────────────────
#
#   • curl and jq installed on the machine running this script
#   • Jenkins Script Console enabled (it is on by default for admins)
#   • An API token for a Jenkins admin user
#     (Manage Jenkins → Users → <user> → Configure → API Token → Add new Token)
#
# ── Usage ─────────────────────────────────────────────────────────────────────
#
#   Export the required variables, then run:
#
#     export JENKINS_URL="https://jenkins.yourorg.com"
#     export JENKINS_USER="admin"
#     export JENKINS_API_TOKEN="<api-token>"
#
#     export DATABASE_URL="postgresql://user:pass@host:5432/test_intel"
#     export GCS_BUCKET="evite-test-intel-artifacts"
#     export GCS_PROJECT="evite-production"
#     export GCS_SA_KEY_PATH="/path/to/gcs-sa-key.json"   # omit for Workload Identity
#
#     export JIRA_BASE_URL="https://evitetracking.atlassian.net"
#     export JIRA_EMAIL="automation@evite.com"
#     export JIRA_API_TOKEN="<jira-api-token>"
#
#     export TESTRAIL_BASE_URL="https://evite.testrail.io"
#     export TESTRAIL_EMAIL="automation@evite.com"
#     export TESTRAIL_API_TOKEN="<testrail-api-token>"
#
#     export TRAPEZE_REPO_URL="git@github.com:evite/results.git"
#
#     bash scripts/jenkins-seed-prod.sh
#
# ── Notes ─────────────────────────────────────────────────────────────────────
#
#   • Idempotent: credentials and jobs that already exist are skipped.
#   • The GCS SA key file (GCS_SA_KEY_PATH) is base64-encoded and embedded
#     directly in the Groovy script so no file transfer to the Jenkins server
#     is required.  Leave GCS_SA_KEY_PATH unset to skip trapeze-gcs-credentials
#     (use this when agents rely on GKE Workload Identity).
#   • TRAPEZE_REPO_URL should be the remote Git URL (not file://) in production.
#     The jobs are created with a 'github-ssh-key' credential; make sure that
#     credential exists on the target Jenkins instance (SSH key for the Git repo).

set -euo pipefail

# ── Validate required env vars ────────────────────────────────────────────────

: "${JENKINS_URL:?Must export JENKINS_URL}"
: "${JENKINS_USER:?Must export JENKINS_USER}"
: "${JENKINS_API_TOKEN:?Must export JENKINS_API_TOKEN}"
: "${DATABASE_URL:?Must export DATABASE_URL}"
: "${GCS_BUCKET:?Must export GCS_BUCKET}"
: "${GCS_PROJECT:?Must export GCS_PROJECT}"
: "${JIRA_BASE_URL:?Must export JIRA_BASE_URL}"
: "${JIRA_EMAIL:?Must export JIRA_EMAIL}"
: "${JIRA_API_TOKEN:?Must export JIRA_API_TOKEN}"
: "${TESTRAIL_BASE_URL:?Must export TESTRAIL_BASE_URL}"
: "${TESTRAIL_EMAIL:?Must export TESTRAIL_EMAIL}"
: "${TESTRAIL_API_TOKEN:?Must export TESTRAIL_API_TOKEN}"
: "${TRAPEZE_REPO_URL:?Must export TRAPEZE_REPO_URL}"

JENKINS_URL="${JENKINS_URL%/}"   # strip trailing slash

# ── Helpers ───────────────────────────────────────────────────────────────────

post_script() {
    local script="$1"
    local response
    response=$(curl --silent --show-error --fail \
        --user "${JENKINS_USER}:${JENKINS_API_TOKEN}" \
        --data-urlencode "script=${script}" \
        "${JENKINS_URL}/scriptText")
    echo "${response}"
}

# Read and base64-encode the GCS SA key if a path was provided
GCS_SA_KEY_B64=""
if [[ -n "${GCS_SA_KEY_PATH:-}" && -f "${GCS_SA_KEY_PATH}" ]]; then
    GCS_SA_KEY_B64=$(base64 < "${GCS_SA_KEY_PATH}" | tr -d '\n')
    echo "==> GCS SA key: ${GCS_SA_KEY_PATH} ($(wc -c < "${GCS_SA_KEY_PATH}") bytes)"
else
    echo "==> GCS_SA_KEY_PATH not set or file not found — trapeze-gcs-credentials will be skipped"
fi

# ── 1. Seed credentials ───────────────────────────────────────────────────────

echo ""
echo "==> [1/3] Seeding credentials on ${JENKINS_URL} ..."

SEED_CREDS_SCRIPT=$(cat <<GROOVY
import jenkins.model.*
import com.cloudbees.plugins.credentials.*
import com.cloudbees.plugins.credentials.domains.*
import com.cloudbees.plugins.credentials.impl.*
import org.jenkinsci.plugins.plaincredentials.impl.*
import hudson.util.Secret

def store  = Jenkins.instance.getExtensionList('com.cloudbees.plugins.credentials.SystemCredentialsProvider')[0].getStore()
def domain = Domain.global()

def credExists = { id -> store.getCredentials(domain).any { it.id == id } }

def addSecretText = { id, value, desc ->
    if (credExists(id)) { println "[seed] '${id}' already exists — skipping"; return }
    store.addCredentials(domain, new StringCredentialsImpl(CredentialsScope.GLOBAL, id, desc, Secret.fromString(value)))
    println "[seed] Created: ${id}"
}

addSecretText('trapeze-db-url',             '${DATABASE_URL}',      'Trapeze: Postgres DATABASE_URL')
addSecretText('trapeze-gcs-bucket',         '${GCS_BUCKET}',        'Trapeze: GCS bucket name')
addSecretText('trapeze-gcs-project',        '${GCS_PROJECT}',       'Trapeze: GCS project ID')
addSecretText('trapeze-jira-base-url',      '${JIRA_BASE_URL}',     'Trapeze: Jira base URL')
addSecretText('trapeze-jira-email',         '${JIRA_EMAIL}',        'Trapeze: Jira service account email')
addSecretText('trapeze-jira-api-token',     '${JIRA_API_TOKEN}',    'Trapeze: Jira API token')
addSecretText('trapeze-testrail-base-url',  '${TESTRAIL_BASE_URL}', 'Trapeze: TestRail base URL')
addSecretText('trapeze-testrail-email',     '${TESTRAIL_EMAIL}',    'Trapeze: TestRail service account email')
addSecretText('trapeze-testrail-api-token', '${TESTRAIL_API_TOKEN}','Trapeze: TestRail API token')

$(if [[ -n "${GCS_SA_KEY_B64}" ]]; then cat <<'INNER'
// Secret-file credential: GCS SA key (base64-encoded bytes embedded inline)
def saKeyId = 'trapeze-gcs-credentials'
if (!credExists(saKeyId)) {
    def b64     = ''"${GCS_SA_KEY_B64}"''
    def bytes   = java.util.Base64.getDecoder().decode(b64)
    def cred    = new FileCredentialsImpl(CredentialsScope.GLOBAL, saKeyId,
                      'Trapeze: GCS service account JSON key', 'sa-key.json',
                      com.cloudbees.plugins.credentials.SecretBytes.fromBytes(bytes))
    store.addCredentials(domain, cred)
    println "[seed] Created: ${saKeyId}"
} else {
    println "[seed] '${saKeyId}' already exists — skipping"
}
INNER
fi)

Jenkins.instance.save()
println "[seed] Done."
GROOVY
)

post_script "${SEED_CREDS_SCRIPT}"

# ── 2. Create pipeline jobs ───────────────────────────────────────────────────

echo ""
echo "==> [2/3] Creating pipeline jobs ..."

CREATE_JOBS_SCRIPT=$(cat <<GROOVY
import jenkins.model.*
import org.jenkinsci.plugins.workflow.job.*
import org.jenkinsci.plugins.workflow.cps.*
import hudson.plugins.git.*
import hudson.triggers.*
import hudson.tasks.*

def repoUrl = '${TRAPEZE_REPO_URL}'
def credId  = 'github-ssh-key'

def jobs = [
    [name: 'trapeze-sync-jira',         scriptPath: 'jenkins/Jenkinsfile.sync-jira',         cron: 'H 6 * * *',     concurrent: false],
    [name: 'trapeze-sync-testrail',     scriptPath: 'jenkins/Jenkinsfile.sync-testrail',     cron: 'H 6 * * *',     concurrent: false],
    [name: 'trapeze-snapshot-coverage', scriptPath: 'jenkins/Jenkinsfile.snapshot-coverage', cron: 'H 7 * * *',     concurrent: false],
    [name: 'trapeze-analyze-flakes',    scriptPath: 'jenkins/Jenkinsfile.analyze-flakes',    cron: 'H 8 * * 1',     concurrent: false],
    [name: 'trapeze-ingest-from-gcs',   scriptPath: 'jenkins/Jenkinsfile.ingest-from-gcs',   cron: 'H/15 * * * *', concurrent: true ],
    // push-testrail has no cron — triggered downstream by ingest-from-gcs or manually
    [name: 'trapeze-push-testrail',     scriptPath: 'jenkins/Jenkinsfile.push-testrail',     cron: '',              concurrent: false],
]

jobs.each { cfg ->
    if (Jenkins.instance.getItem(cfg.name)) {
        println "[jobs] '${cfg.name}' already exists — skipping"; return
    }
    def job = Jenkins.instance.createProject(WorkflowJob, cfg.name)
    def urc = new UserRemoteConfig(repoUrl, null, null, credId)
    def scm = new GitSCM([urc], [new BranchSpec('*/main')], false, [], null, null, [])
    def def_ = new CpsScmFlowDefinition(scm, cfg.scriptPath)
    def_.setLightweight(true)
    job.setDefinition(def_)
    if (cfg.cron) { job.addTrigger(new TimerTrigger(cfg.cron)) }
    job.setConcurrentBuild(cfg.concurrent)
    job.setBuildDiscarder(new LogRotator(-1, 30, -1, -1))
    job.save()
    println "[jobs] Created: ${cfg.name}"
}

Jenkins.instance.save()
println "[jobs] Done."
GROOVY
)

post_script "${CREATE_JOBS_SCRIPT}"

# ── 3. Register shared library ────────────────────────────────────────────────

echo ""
echo "==> [3/3] Registering 'trapeze' shared library ..."

REGISTER_LIB_SCRIPT=$(cat <<GROOVY
import jenkins.model.*
import org.jenkinsci.plugins.workflow.libs.*
import jenkins.plugins.git.GitSCMSource
import jenkins.plugins.git.traits.BranchDiscoveryTrait

def libName = 'trapeze'
def repoUrl = '${TRAPEZE_REPO_URL}'
def gld     = Jenkins.instance.getDescriptor(GlobalLibraries.class)
def libs    = gld.getLibraries()

if (libs.any { it.name == libName }) {
    println "[lib] '${libName}' already registered — skipping"
} else {
    def src = new GitSCMSource(repoUrl)
    src.traits = [new BranchDiscoveryTrait()]
    def lib = new LibraryConfiguration(libName, new SCMSourceRetriever(src))
    lib.setDefaultVersion('main')
    lib.setImplicit(false)
    lib.setAllowVersionOverride(true)
    gld.setLibraries(libs + [lib])
    Jenkins.instance.save()
    println "[lib] Registered '${libName}' → ${repoUrl}"
}
GROOVY
)

post_script "${REGISTER_LIB_SCRIPT}"

echo ""
echo "==> All done. Verify at ${JENKINS_URL}:"
echo "    Jobs:        ${JENKINS_URL}/api/json?tree=jobs[name]"
echo "    Credentials: ${JENKINS_URL}/credentials/store/system/domain/_/api/json"
echo "    Libraries:   ${JENKINS_URL}/manage/descriptorByName/org.jenkinsci.plugins.workflow.libs.GlobalLibraries/api/json"
