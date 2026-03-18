/**
 * 01-create-admin.groovy
 *
 * Creates a local admin user on first boot.
 * Credentials: admin / trapeze-local
 *
 * Override by setting JENKINS_ADMIN_PASSWORD env var before starting the container.
 * In production, remove this file and manage users via LDAP / SSO.
 */
import jenkins.model.*
import hudson.security.*

def instance = Jenkins.getInstance()

// Only create the user if security has not been configured yet
if (instance.getSecurityRealm() instanceof HudsonPrivateSecurityRealm &&
    !instance.getSecurityRealm().getAllUsers().any { it.id == "admin" }) {

    def hudsonRealm = new HudsonPrivateSecurityRealm(false)
    def password    = System.getenv("JENKINS_ADMIN_PASSWORD") ?: "trapeze-local"
    hudsonRealm.createAccount("admin", password)
    instance.setSecurityRealm(hudsonRealm)

    def strategy = new FullControlOnceLoggedInAuthorizationStrategy()
    strategy.setAllowAnonymousRead(false)
    instance.setAuthorizationStrategy(strategy)

    instance.save()
    println "[init] Admin user created (password: ${password == 'trapeze-local' ? 'trapeze-local (default)' : '***'})"
} else {
    println "[init] Admin user already exists — skipping creation."
}
