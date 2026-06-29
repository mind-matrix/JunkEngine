const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const TerserPlugin = require('terser-webpack-plugin');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = (env, argv) => {
    const isProduction = argv.mode === 'production';

    return {
        entry: './src/demo.ts',
        output: {
            filename: 'bundle.js',
            path: path.resolve(__dirname, 'dist'),
            clean: true,
        },
        resolve: {
            extensions: ['.ts', '.js'],
            alias: {
                '@': path.resolve(__dirname, 'src'),
            },
        },
        module: {
            rules: [
                {
                    test: /\.ts$/,
                    use: 'ts-loader',
                    exclude: /node_modules/,
                },
                {
                    test: /\.wgsl$/i,
                    type: 'asset/source',
                },
                {
                    test: /\.(png|jpe?g|gif|svg|webp)$/i,
                    type: 'asset/resource',
                    generator: {
                        filename: 'assets/[name][ext]',
                    },
                },
            ],
        },
        plugins: [
            new HtmlWebpackPlugin({
                template: './public/index.html',
                filename: 'index.html',
                inject: 'body',
            }),
            new HtmlWebpackPlugin({
                template: './public/demo.html',
                filename: 'demo.html',
                inject: 'body',
            }),
            new CopyWebpackPlugin({
                patterns: [
                    {
                        from: 'public',
                        to: '.',
                        globOptions: {
                            ignore: ['**/index.html', '**/demo.html'],
                        },
                    },
                    {
                        from: 'assets',
                        to: '.',
                    },
                ],
            }),
        ],
        optimization: {
            minimize: isProduction,
            minimizer: [
                new TerserPlugin({
                    terserOptions: {
                        compress: {
                            drop_console: isProduction,
                        },
                        mangle: true,
                    },
                }),
            ],
        },
        devServer: {
            static: [
                {
                    directory: path.join(__dirname, 'dist'),
                },
                {
                    directory: path.join(__dirname, 'public'),
                    publicPath: '/',
                },
            ],
            compress: true,
            port: 8080,
            hot: true,
        },
        devtool: isProduction ? false : 'source-map',
    };
};
