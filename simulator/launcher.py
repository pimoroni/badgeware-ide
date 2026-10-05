# Eat the wakeup button press to prevent it leaking into the menu
badge.poll()

# (temporarily auto-launching the world app for rasteriser testing)
app_to_launch = launch("/apps/menu")

if app_to_launch is not None:

    # Don't pass menu button presses into the newly launched app
    while badge.pressed() or badge.held() or badge.released():
        badge.poll()

    launch(app_to_launch)

# Catch any exit and reset back to the launcher
reset()
