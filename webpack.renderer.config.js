const path = require('path');

const common = {
  mode: 'development',
  target: 'electron-renderer',
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: { loader: 'ts-loader', options: { configFile: 'tsconfig.renderer.json' } },
        exclude: /node_modules/,
      },
      { test: /\.css$/, use: ['style-loader', 'css-loader'] },
      { test: /\.(png|jpg|gif|svg)$/, type: 'asset/resource' },
    ],
  },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  output: {
    path: path.resolve(__dirname, 'dist/renderer'),
    assetModuleFilename: 'assets/[name][ext]',
  },
};

module.exports = [
  {
    ...common,
    entry: './src/renderer/index.tsx',
    output: { ...common.output, filename: 'bundle.js' },
  },
  {
    ...common,
    entry: './src/renderer/badge-entry.tsx',
    output: { ...common.output, filename: 'badge.bundle.js' },
  },
];
