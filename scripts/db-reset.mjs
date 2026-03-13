import { execSync } from "node:child_process";

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

run("docker compose down -v");
run("docker compose up -d");
console.log("\nPostgres reset complete. Next: npm run db:migrate && npm run db:seed");
