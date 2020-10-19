import { ConfigPlugin, ExportedConfig } from '../../Plugin.types';
import { withExtendedModifier, withPlugins } from '../core-plugins';
import { evalModifiersAsync } from '../modifier-compiler';

describe(withPlugins, () => {
  it('compiles plugins in the correct order', () => {
    const pluginA: ConfigPlugin = config => {
      config.expo.extra.push('alpha');
      return config;
    };
    const pluginB: ConfigPlugin = (config, props = 'charlie') => {
      config.expo.extra.push('beta', props);
      return config;
    };

    expect(
      withPlugins({ expo: { extra: [] } } as any, [
        // Standard plugin
        pluginA,
        // Plugin with no properties
        // @ts-ignore: users shouldn't do this.
        [pluginB],
        // Plugin with properties
        [pluginB, 'delta'],
      ])
    ).toStrictEqual({ expo: { extra: ['alpha', 'beta', 'charlie', 'beta', 'delta'] } });
  });
  it('fixes the expo config object', () => {
    expect(withPlugins({ name: 'hey' } as any, [])).toStrictEqual({ expo: { name: 'hey' } });
  });
});

describe(withExtendedModifier, () => {
  it('compiles modifiers', async () => {
    // A basic plugin exported from an app.json
    const exportedConfig: ExportedConfig = { expo: { name: 'app', slug: '' }, modifiers: null };

    // Apply modifier
    let config = withExtendedModifier<any>(exportedConfig, {
      platform: 'android',
      modifier: 'custom',
      action(props) {
        // Capitalize app name
        props.expo.name = (props.expo.name as string).toUpperCase();
        return props;
      },
    });

    // Compile plugins generically
    config = await evalModifiersAsync(config, { projectRoot: '/' });

    // App config should have been modified
    expect(config.expo).toStrictEqual({
      name: 'APP',
      slug: '',
    });

    // Plugins should all be functions
    expect(
      Object.values(config.modifiers.android).every(value => typeof value === 'function')
    ).toBe(true);
  });
});
