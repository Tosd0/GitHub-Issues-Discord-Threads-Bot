const path = require("path");

module.exports = {
  entry: "./src/index.ts",
  target: "node",
  mode: "development", // TODO: Resolve issue in production mode where `client.actions.ThreadCreate.handle(packet.d);` throws an error due to 'ThreadCreate' being undefined.
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: "ts-loader",
          // Compile only what the bundle actually reaches. Without this
          // ts-loader type-checks every file tsconfig covers, so the build
          // pulls in the *.test.ts files and fails wherever the test runner
          // is not installed. `npx tsc --noEmit` still checks them.
          options: { onlyCompileBundledFiles: true },
        },
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    fallback: {
      "zlib-sync": false,
    },
    extensions: [".tsx", ".ts", ".js"],
  },
  output: {
    filename: "index.js",
    path: path.resolve(__dirname, "dist"),
  },
  optimization: {
    minimize: true,
  },
  node: {
    __dirname: false,
    __filename: false,
  },
};
