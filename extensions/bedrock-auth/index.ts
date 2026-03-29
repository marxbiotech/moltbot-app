import { awsAuth } from "./src/aws-auth.ts";

export default function register(api: any) {
  api.registerCommand({
    name: "aws_auth",
    description: "Authenticate AWS Bedrock with MFA code",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx: any) => {
      const args = ctx.args?.trim() || undefined;
      return awsAuth(args);
    },
  });
}
