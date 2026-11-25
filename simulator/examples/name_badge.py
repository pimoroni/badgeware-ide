badge.mode(FAST_UPDATE)

mona = font.mona_sans
names = ["Badger", "Blinky", "Tufty"]
index = 0

def update():
    global index
    if badge.pressed(BUTTON_UP):
        index = (index - 1) % len(names)
    if badge.pressed(BUTTON_DOWN):
        index = (index + 1) % len(names)

    w = screen.width
    h = screen.height
    screen.font = mona
    screen.antialias = image.X2

    screen.pen = color.rgb(255, 255, 255)
    screen.clear()

    screen.pen = color.rgb(0, 0, 0)
    screen.rectangle(0, 0, w, 40)
    screen.pen = color.rgb(255, 255, 255)
    screen.text("HELLO, my name is", rect(12, 6, w - 24, 30), font_size=20)

    screen.pen = color.rgb(0, 0, 0)
    screen.text(names[index], rect(14, 46, w - 28, 90), font_size=48)

    screen.pen = color.rgb(170, 170, 170)
    screen.rectangle(14, h - 36, w - 28, 14)
    screen.pen = color.rgb(90, 90, 90)
    screen.rectangle(14, h - 36, int((index + 1) / len(names) * (w - 28)), 14)

    badge.update()
    wait_for_button_or_alarm(timeout=None)

run(update)
