package main

import (
	"fmt"
	"os"

	dem "github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs"
	"github.com/markus-wa/demoinfocs-golang/v5/pkg/demoinfocs/events"
)

func main() {
	f, err := os.Open(os.Args[1])
	if err != nil {
		fmt.Println("FALHOU (não abriu o arquivo)")
		return
	}
	defer f.Close()
	p := dem.NewParser(f)
	defer p.Close()
	rodadas, mortes := 0, 0
	p.RegisterEventHandler(func(events.RoundEnd) { rodadas++ })
	p.RegisterEventHandler(func(events.Kill) { mortes++ })
	err = p.ParseToEnd()
	if err != nil && rodadas == 0 {
		msg := err.Error()
		if len(msg) > 80 {
			msg = msg[:80]
		}
		fmt.Printf("FALHOU (%s)\n", msg)
		return
	}
	aviso := ""
	if err != nil {
		aviso = ", terminou com aviso"
	}
	if rodadas == 0 {
		fmt.Println("FALHOU (leu o arquivo mas não achou nenhuma rodada)")
		return
	}
	fmt.Printf("ABRIU (rodadas %d, mortes %d%s)\n", rodadas, mortes, aviso)
}
