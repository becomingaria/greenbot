#!/usr/bin/env bash
# greenbot.sh — manage the greenbot EC2 deployment
#
# Usage:
#   ./scripts/greenbot.sh ship       # git commit+push, sync src/+config to EC2 via S3, restart
#   ./scripts/greenbot.sh config     # push config/config.yaml to instance via S3 + restart
#   ./scripts/greenbot.sh code       # push src/ to instance via S3 + restart
#   ./scripts/greenbot.sh deploy     # full redeploy via CDK (new code + infra)
#   ./scripts/greenbot.sh restart    # restart the systemd service
#   ./scripts/greenbot.sh logs       # tail the last 100 lines of service logs
#   ./scripts/greenbot.sh status     # show service status
#   ./scripts/greenbot.sh teardown   # destroy all AWS resources (prompts for confirmation)

set -euo pipefail

AWS_PROFILE="${AWS_PROFILE:-personal}"
INSTANCE_ID="i-09c450ea893ed1f7c"
S3_BUCKET="greenbotstack-greenbotconfigbucketdca5493a-j9wulozj3ibx"
REMOTE_ROOT="/opt/greenbot"
LOCAL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── helpers ──────────────────────────────────────────────────────────────────

ssm_run() {
    local label="$1"
    local commands="$2"
    echo "→ $label"
    local cmd_id
    cmd_id=$(aws ssm send-command \
        --profile "$AWS_PROFILE" \
        --instance-ids "$INSTANCE_ID" \
        --document-name "AWS-RunShellScript" \
        --parameters "{\"commands\":[\"$commands\"]}" \
        --output text --query 'Command.CommandId')

    echo "  waiting for command $cmd_id..."
    local status=""
    local attempts=0
    while [[ "$status" != "Success" && "$status" != "Failed" && "$status" != "TimedOut" ]]; do
        sleep 3
        status=$(aws ssm get-command-invocation \
            --profile "$AWS_PROFILE" \
            --command-id "$cmd_id" \
            --instance-id "$INSTANCE_ID" \
            --query 'Status' --output text 2>/dev/null || echo "Pending")
        attempts=$((attempts + 1))
        if [[ $attempts -ge 20 ]]; then
            echo "  timed out waiting for command"
            break
        fi
    done

    local out
    out=$(aws ssm get-command-invocation \
        --profile "$AWS_PROFILE" \
        --command-id "$cmd_id" \
        --instance-id "$INSTANCE_ID" \
        --query '[StandardOutputContent,StandardErrorContent]' \
        --output text)
    echo "$out"

    if [[ "$status" == "Failed" ]]; then
        echo "✗ command failed"
        return 1
    fi
    echo "✓ $label done"
}

# ── commands ─────────────────────────────────────────────────────────────────

cmd_config() {
    echo "→ uploading config/config.yaml to S3..."
    aws s3 cp "$LOCAL_ROOT/config/config.yaml" \
        "s3://$S3_BUCKET/deploy/config/config.yaml" \
        --profile "$AWS_PROFILE"

    ssm_run "pull config from S3" \
        "aws s3 cp s3://$S3_BUCKET/deploy/config/config.yaml $REMOTE_ROOT/config/config.yaml --region us-east-1"
    ssm_run "restart service" \
        "systemctl restart greenbot && systemctl status greenbot --no-pager -l"
}

cmd_code() {
    echo "→ syncing src/ to S3..."
    aws s3 sync "$LOCAL_ROOT/src/" \
        "s3://$S3_BUCKET/deploy/src/" \
        --profile "$AWS_PROFILE" --delete

    ssm_run "pull src from S3" \
        "aws s3 sync s3://$S3_BUCKET/deploy/src/ $REMOTE_ROOT/src/ --region us-east-1 --delete"
    ssm_run "restart service" \
        "systemctl restart greenbot && systemctl status greenbot --no-pager -l"
}

cmd_ship() {
    # 1. Commit and push any uncommitted changes
    cd "$LOCAL_ROOT"
    if [[ -n $(git status --porcelain) ]]; then
        echo "→ committing local changes..."
        git add -A
        git commit -m "chore: ship $(date '+%Y-%m-%d %H:%M')"
    else
        echo "→ nothing to commit, working tree clean"
    fi

    echo "→ pushing to origin..."
    git push

    # 2. Sync src/ and config/ to EC2 via S3
    echo "→ syncing src/ to S3..."
    aws s3 sync "$LOCAL_ROOT/src/" \
        "s3://$S3_BUCKET/deploy/src/" \
        --profile "$AWS_PROFILE" --delete

    echo "→ uploading config/config.yaml to S3..."
    aws s3 cp "$LOCAL_ROOT/config/config.yaml" \
        "s3://$S3_BUCKET/deploy/config/config.yaml" \
        --profile "$AWS_PROFILE"

    ssm_run "pull src from S3" \
        "aws s3 sync s3://$S3_BUCKET/deploy/src/ $REMOTE_ROOT/src/ --region us-east-1 --delete"
    ssm_run "pull config from S3" \
        "aws s3 cp s3://$S3_BUCKET/deploy/config/config.yaml $REMOTE_ROOT/config/config.yaml --region us-east-1"
    ssm_run "restart service" \
        "systemctl restart greenbot && systemctl status greenbot --no-pager -l"
    echo "✓ shipped"
}

cmd_deploy() {
    echo "Running full CDK deploy..."
    pushd "$LOCAL_ROOT/infra" > /dev/null
    npm install --silent
    AWS_PROFILE="$AWS_PROFILE" npx cdk deploy --all --require-approval never
    popd > /dev/null
    echo "✓ deploy complete"
}

cmd_restart() {
    ssm_run "restart service" "systemctl restart greenbot && systemctl status greenbot --no-pager -l"
}

cmd_logs() {
    ssm_run "fetch logs" "journalctl -u greenbot -n 100 --no-pager"
}

cmd_status() {
    ssm_run "service status" "systemctl status greenbot --no-pager -l"
}

cmd_teardown() {
    echo ""
    echo "WARNING: This will destroy all greenbot AWS resources:"
    echo "  - EC2 instance (i-09c450ea893ed1f7c)"
    echo "  - S3 config bucket (RETAIN policy — will NOT be deleted by CDK)"
    echo "  - DynamoDB state table (RETAIN policy — will NOT be deleted by CDK)"
    echo "  - IAM roles, security groups, EventBridge schedules, budget alert"
    echo ""
    read -r -p "Type 'destroy' to confirm: " confirm
    if [[ "$confirm" != "destroy" ]]; then
        echo "Aborted."
        exit 0
    fi

    echo "Stopping service before teardown..."
    aws ssm send-command \
        --profile "$AWS_PROFILE" \
        --instance-ids "$INSTANCE_ID" \
        --document-name "AWS-RunShellScript" \
        --parameters '{"commands":["systemctl stop greenbot || true"]}' \
        --output text --query 'CommandId' > /dev/null || true

    echo "Running CDK destroy..."
    pushd "$LOCAL_ROOT/infra" > /dev/null
    npm install --silent
    AWS_PROFILE="$AWS_PROFILE" npx cdk destroy --all --force
    popd > /dev/null

    echo ""
    echo "✓ Stack destroyed."
    echo "  Note: S3 bucket and DynamoDB table have RETAIN policies."
    echo "  Delete them manually in the AWS console if no longer needed."
}

# ── dispatch ─────────────────────────────────────────────────────────────────

case "${1:-}" in
    ship)     cmd_ship ;;
    config)   cmd_config ;;
    code)     cmd_code ;;
    deploy)   cmd_deploy ;;
    restart)  cmd_restart ;;
    logs)     cmd_logs ;;
    status)   cmd_status ;;
    teardown) cmd_teardown ;;
    *)
        echo "Usage: $0 {ship|config|code|deploy|restart|logs|status|teardown}"
        exit 1
        ;;
esac
