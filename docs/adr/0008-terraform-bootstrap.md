# 0008. Terraform bootstrap: remote state and GitHub OIDC

* Status: accepted
* Date: 2026-10-08
* Issue: #8

## Context

Pixel will run on Azure Container Apps. Terraform must not keep state on a laptop, and GitHub Actions must not hold a long-lived Azure password. The subscription, region, and how hosted Pixel reaches Home Assistant are now known.

## Decision

- **Subscription** `d150e252-e2f0-47fb-8a4a-c3f29e9aebd4`, region **West Europe**.
- **`infra/bootstrap`** is applied by hand, by an Owner of that subscription. It creates:
  - resource groups `pixel-bootstrap`, `pixel-dev`, `pixel-prod`
  - a storage account for state, with shared keys off, Azure AD auth, versioning, and soft delete
  - one user-assigned identity per environment, federated only to `repo:pixelbar/pixel:environment:<env>`
- Environment configs (#9, #12) use the `dev` and `prod` containers as their backend and deploy **into** the env resource groups. They do not create those groups.
- GitHub identities are **Contributor on their env resource group**, not on the subscription. They cannot see the other environment’s group.
- Bootstrap’s own state is local for the first apply, then migrated into the `bootstrap` container.
- **Home Assistant from Azure:** prefer a Tailscale sidecar so the container talks to HA on the LAN. Keep supporting a Nabu Casa URL (`HOME_ASSISTANT_URL`) as today. The sidecar is #9 / #43, not this stack.

## Consequences

- Someone with Owner must run the first apply and create GitHub Environments `dev` and `prod` (reviewers on `prod`).
- CD (#10) logs in with OIDC (`ARM_CLIENT_ID` / `ARM_TENANT_ID` / `ARM_SUBSCRIPTION_ID` as variables, `id-token: write`). No Azure client secret in GitHub.
- Tightening GitHub’s rights later is a role assignment change, not a new app registration.
- A Nabu Casa URL still works if Tailscale is not ready when `dev` first comes up.
