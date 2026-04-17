import { $, chalk } from "zx";

async function main() {
  console.log(chalk.blue("Building the project..."));

  // todo:

  console.log(chalk.green("Build completed successfully!"));
}

main().catch((err) => {
  console.error(chalk.red("Build failed with error:"));
  console.error(err);
  process.exit(1);
});
