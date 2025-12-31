/**
 * CLI for calling the flightpath agent backend
 * Usage: bun run ask "your message here"
 */

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:8787";

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.error("Usage: bun run ask <message>");
    console.error('Example: bun run ask "hello"');
    process.exit(1);
  }

  const message = args.join(" ");

  try {
    const response = await fetch(`${BACKEND_URL}/api/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ message }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Error:", data.error || "Unknown error");
      if (data.details) {
        console.error("Details:", data.details);
      }
      process.exit(1);
    }

    console.log("Reply:", data.reply);
    console.log("Request ID:", data.requestId);
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("ECONNREFUSED")) {
        console.error(
          `Error: Cannot connect to backend at ${BACKEND_URL}`
        );
        console.error("Make sure the backend is running with: cd backend && bun run dev");
      } else {
        console.error("Error:", error.message);
      }
    } else {
      console.error("Unknown error occurred");
    }
    process.exit(1);
  }
}

main();
